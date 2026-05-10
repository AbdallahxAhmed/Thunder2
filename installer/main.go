package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/ulikunitz/xz"
)

type toolID string

const (
	toolAria2   toolID = "aria2c"
	toolYtDlp   toolID = "yt-dlp"
	toolM3u8    toolID = "N_m3u8DL-RE"
	toolFfmpeg  toolID = "ffmpeg"
	toolFfprobe toolID = "ffprobe"
)

type tool struct {
	id       toolID
	display  string
	binaries []string
	install  func(context.Context, string, packageManager) error
}

type toolStatus int

const (
	statusPending toolStatus = iota
	statusInstalling
	statusDone
	statusFailed
)

type toolState struct {
	tool    tool
	status  toolStatus
	message string
}

type installMsg struct {
	index int
	err   error
}

type packageManager struct {
	name       string
	installCmd []string
}

var (
	brand = lipgloss.NewStyle().Foreground(lipgloss.Color("62")).Bold(true)
	ok    = lipgloss.NewStyle().Foreground(lipgloss.Color("42"))
	warn  = lipgloss.NewStyle().Foreground(lipgloss.Color("214"))
	bad   = lipgloss.NewStyle().Foreground(lipgloss.Color("160"))
	muted = lipgloss.NewStyle().Foreground(lipgloss.Color("244"))
)

type model struct {
	os         string
	arch       string
	binDir     string
	tools      []toolState
	installing bool
	spinner    spinner.Model
	err        string
}

func main() {
	binDirFlag := flag.String("bin-dir", "", "Destination directory for binaries")
	nonInteractive := flag.Bool("non-interactive", false, "Run without UI and exit on failure")
	flag.Parse()

	binDir := *binDirFlag
	if binDir == "" {
		binDir = os.Getenv("BIN_DIR")
	}
	if binDir == "" {
		binDir = "./bin"
	}

	binDir, _ = filepath.Abs(binDir)

	if err := os.MkdirAll(binDir, 0o755); err != nil {
		fmt.Printf("failed to create BIN_DIR: %v\n", err)
		os.Exit(1)
	}

	pm := detectPackageManager()
	tools := buildTools()
	states := make([]toolState, 0, len(tools))
	for _, t := range tools {
		state := toolState{tool: t, status: statusPending}
		if toolInstalled(t, binDir) {
			state.status = statusDone
		}
		states = append(states, state)
	}

	if *nonInteractive {
		exitCode := runNonInteractive(binDir, pm, states)
		os.Exit(exitCode)
	}

	sp := spinner.New()
	sp.Spinner = spinner.Line

	m := model{
		os:      runtime.GOOS,
		arch:    runtime.GOARCH,
		binDir:  binDir,
		tools:   states,
		spinner: sp,
	}
	p := tea.NewProgram(m)
	if _, err := p.Run(); err != nil {
		fmt.Printf("installer failed: %v\n", err)
		os.Exit(1)
	}
}

func buildTools() []tool {
	return []tool{
		{
			id:       toolAria2,
			display:  "aria2c",
			binaries: []string{"aria2c"},
			install:  installAria2,
		},
		{
			id:       toolYtDlp,
			display:  "yt-dlp",
			binaries: []string{"yt-dlp"},
			install:  installYtDlp,
		},
		{
			id:       toolM3u8,
			display:  "N_m3u8DL-RE",
			binaries: []string{"N_m3u8DL-RE"},
			install:  installM3u8,
		},
		{
			id:       toolFfmpeg,
			display:  "ffmpeg",
			binaries: []string{"ffmpeg", "ffprobe"},
			install:  installFfmpeg,
		},
	}
}

func (m model) Init() tea.Cmd {
	return m.spinner.Tick
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "i":
			if !m.installing {
				m.installing = true
				return m, installNextCmd(&m)
			}
		case "r":
			if !m.installing {
				for i := range m.tools {
					if m.tools[i].status == statusFailed {
						m.tools[i].status = statusPending
						m.tools[i].message = ""
					}
				}
				m.installing = true
				return m, installNextCmd(&m)
			}
		}
	case installMsg:
		if msg.index >= 0 && msg.index < len(m.tools) {
			if msg.err != nil {
				m.tools[msg.index].status = statusFailed
				m.tools[msg.index].message = msg.err.Error()
			} else {
				m.tools[msg.index].status = statusDone
				m.tools[msg.index].message = "installed"
			}
		}
		next := nextPendingIndex(m.tools)
		if next >= 0 {
			m.tools[next].status = statusInstalling
			return m, installToolCmd(next, m.binDir, m.tools[next].tool)
		}
		m.installing = false
		return m, nil
	}

	var cmd tea.Cmd
	m.spinner, cmd = m.spinner.Update(msg)
	return m, cmd
}

func (m model) View() string {
	var b strings.Builder
	b.WriteString(brand.Render("Thunder Installer"))
	b.WriteString("\n")
	b.WriteString(muted.Render(fmt.Sprintf("OS: %s  ARCH: %s\n", m.os, m.arch)))
	b.WriteString(muted.Render(fmt.Sprintf("BIN_DIR: %s\n\n", m.binDir)))

	for _, t := range m.tools {
		status := statusLabel(t.status, m.spinner.View(), t.message)
		b.WriteString(fmt.Sprintf("%s %s\n", status, t.tool.display))
	}

	b.WriteString("\n")
	if m.installing {
		b.WriteString(muted.Render("Installing..."))
	} else {
		b.WriteString(muted.Render("Press i to install, r to retry failed, q to quit"))
	}
	if m.err != "" {
		b.WriteString("\n")
		b.WriteString(bad.Render(m.err))
	}
	b.WriteString("\n")
	return b.String()
}

func statusLabel(status toolStatus, spin string, message string) string {
	switch status {
	case statusDone:
		return ok.Render("✔")
	case statusFailed:
		return bad.Render("✖") + " " + warn.Render(message)
	case statusInstalling:
		return spin
	default:
		return muted.Render("•")
	}
}

func installNextCmd(m *model) tea.Cmd {
	idx := nextPendingIndex(m.tools)
	if idx < 0 {
		m.installing = false
		return nil
	}
	m.tools[idx].status = statusInstalling
	return installToolCmd(idx, m.binDir, m.tools[idx].tool)
}

func nextPendingIndex(tools []toolState) int {
	for i, t := range tools {
		if t.status == statusPending {
			return i
		}
	}
	return -1
}

func installToolCmd(index int, binDir string, tool tool) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		pm := detectPackageManager()
		err := tool.install(ctx, binDir, pm)
		return installMsg{index: index, err: err}
	}
}

func runNonInteractive(binDir string, pm packageManager, tools []toolState) int {
	failed := false
	for i := range tools {
		if tools[i].status == statusDone {
			fmt.Printf("%s already installed\n", tools[i].tool.display)
			continue
		}
		fmt.Printf("Installing %s...\n", tools[i].tool.display)
		if err := tools[i].tool.install(context.Background(), binDir, pm); err != nil {
			failed = true
			fmt.Printf("FAILED %s: %v\n", tools[i].tool.display, err)
		} else {
			fmt.Printf("OK %s\n", tools[i].tool.display)
		}
	}
	if failed {
		return 1
	}
	return 0
}

func toolInstalled(t tool, binDir string) bool {
	for _, bin := range t.binaries {
		if resolveBinary(bin, binDir) == "" {
			return false
		}
	}
	return true
}

func resolveBinary(name, binDir string) string {
	candidates := []string{name}
	if runtime.GOOS == "windows" && !strings.HasSuffix(strings.ToLower(name), ".exe") {
		candidates = append(candidates, name+".exe")
	}
	for _, candidate := range candidates {
		local := filepath.Join(binDir, candidate)
		if fileExists(local) {
			return local
		}
		if path, err := exec.LookPath(candidate); err == nil {
			return path
		}
	}
	return ""
}

func detectPackageManager() packageManager {
	managers := []packageManager{}
	if runtime.GOOS == "darwin" {
		managers = append(managers, packageManager{name: "brew", installCmd: []string{"brew", "install"}})
		managers = append(managers, packageManager{name: "port", installCmd: []string{"port", "install"}})
	} else if runtime.GOOS == "windows" {
		managers = append(managers, packageManager{name: "winget", installCmd: []string{"winget", "install", "--silent", "--accept-package-agreements", "--accept-source-agreements"}})
		managers = append(managers, packageManager{name: "choco", installCmd: []string{"choco", "install", "-y"}})
		managers = append(managers, packageManager{name: "scoop", installCmd: []string{"scoop", "install"}})
	} else {
		managers = append(managers,
			packageManager{name: "apt-get", installCmd: []string{"apt-get", "install", "-y"}},
			packageManager{name: "dnf", installCmd: []string{"dnf", "install", "-y"}},
			packageManager{name: "yum", installCmd: []string{"yum", "install", "-y"}},
			packageManager{name: "pacman", installCmd: []string{"pacman", "-S", "--noconfirm"}},
			packageManager{name: "apk", installCmd: []string{"apk", "add"}},
			packageManager{name: "zypper", installCmd: []string{"zypper", "install", "-y"}},
		)
	}
	for _, pm := range managers {
		if _, err := exec.LookPath(pm.name); err == nil {
			return pm
		}
	}
	return packageManager{}
}

func runPackageInstall(ctx context.Context, pm packageManager, packages []string) error {
	if pm.name == "" {
		return errors.New("no package manager detected")
	}
	args := append([]string{}, pm.installCmd...)
	args = append(args, packages...)
	cmdName := args[0]
	cmdArgs := args[1:]
	if needsSudo(cmdName) {
		if sudo, err := exec.LookPath("sudo"); err == nil {
			cmdArgs = append([]string{cmdName}, cmdArgs...)
			cmdName = sudo
		}
	}
	cmd := exec.CommandContext(ctx, cmdName, cmdArgs...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func needsSudo(cmdName string) bool {
	if runtime.GOOS == "windows" {
		return false
	}
	if os.Geteuid() == 0 {
		return false
	}
	return cmdName == "apt-get" || cmdName == "dnf" || cmdName == "yum" || cmdName == "apk" || cmdName == "zypper" || cmdName == "pacman"
}

func installAria2(ctx context.Context, binDir string, pm packageManager) error {
	if resolveBinary("aria2c", binDir) != "" {
		return nil
	}
	if pm.name != "" {
		if err := runPackageInstall(ctx, pm, []string{"aria2"}); err == nil {
			if err := copyFromPath("aria2c", binDir); err == nil {
				return nil
			}
		}
	}
	return installFromGitHub(ctx, binDir, "aria2/aria2", aria2Matchers())
}

func installYtDlp(ctx context.Context, binDir string, pm packageManager) error {
	if resolveBinary("yt-dlp", binDir) != "" {
		return nil
	}
	if pm.name != "" {
		if err := runPackageInstall(ctx, pm, []string{"yt-dlp"}); err == nil {
			if err := copyFromPath("yt-dlp", binDir); err == nil {
				return nil
			}
		}
	}
	url := "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"
	if runtime.GOOS == "windows" {
		url += ".exe"
	}
	return downloadToBin(ctx, url, "yt-dlp", binDir)
}

func installM3u8(ctx context.Context, binDir string, pm packageManager) error {
	if resolveBinary("N_m3u8DL-RE", binDir) != "" {
		return nil
	}
	return installFromGitHub(ctx, binDir, "nilaoda/N_m3u8DL-RE", m3u8Matchers())
}

func installFfmpeg(ctx context.Context, binDir string, pm packageManager) error {
	if resolveBinary("ffmpeg", binDir) != "" && resolveBinary("ffprobe", binDir) != "" {
		return nil
	}
	if pm.name != "" {
		if err := runPackageInstall(ctx, pm, []string{"ffmpeg"}); err == nil {
			if err := copyFromPath("ffmpeg", binDir); err == nil {
				_ = copyFromPath("ffprobe", binDir)
				return nil
			}
		}
	}
	return installFromGitHub(ctx, binDir, "BtbN/FFmpeg-Builds", ffmpegMatchers())
}

func aria2Matchers() [][]string {
	if runtime.GOOS == "windows" {
		return [][]string{{"win", "64", "zip"}, {"win", "x64", "zip"}}
	}
	if runtime.GOOS == "darwin" {
		return [][]string{{"osx", "tar"}, {"mac", "tar"}, {"darwin", "tar"}}
	}
	if runtime.GOARCH == "arm64" {
		return [][]string{{"linux", "arm64"}, {"linux", "aarch64"}}
	}
	return [][]string{{"linux", "64"}, {"linux", "x64"}}
}

func m3u8Matchers() [][]string {
	if runtime.GOOS == "windows" {
		return [][]string{{"win", "x64", "zip"}, {"win", "64", "zip"}, {"win", "arm64"}}
	}
	if runtime.GOOS == "darwin" {
		if runtime.GOARCH == "arm64" {
			return [][]string{{"osx", "arm64"}, {"mac", "arm64"}}
		}
		return [][]string{{"osx", "x64"}, {"mac", "x64"}}
	}
	if runtime.GOARCH == "arm64" {
		return [][]string{{"linux", "arm64"}, {"linux", "aarch64"}}
	}
	return [][]string{{"linux", "x64"}, {"linux", "64"}}
}

func ffmpegMatchers() [][]string {
	if runtime.GOOS == "windows" {
		return [][]string{{"win64", "zip"}, {"windows", "64", "zip"}}
	}
	if runtime.GOOS == "darwin" {
		if runtime.GOARCH == "arm64" {
			return [][]string{{"mac", "arm64"}, {"darwin", "arm64"}}
		}
		return [][]string{{"mac", "x64"}, {"macos", "64"}}
	}
	if runtime.GOARCH == "arm64" {
		return [][]string{{"linux", "arm64"}, {"linux", "aarch64"}}
	}
	return [][]string{{"linux", "64"}, {"linux", "x64"}}
}

type ghAsset struct {
	Name string `json:"name"`
	URL  string `json:"browser_download_url"`
}

type ghRelease struct {
	Assets []ghAsset `json:"assets"`
}

func installFromGitHub(ctx context.Context, binDir, repo string, matchers [][]string) error {
	release, err := fetchLatestRelease(ctx, repo)
	if err != nil {
		return err
	}
	assetURL, assetName, err := selectAsset(release, matchers)
	if err != nil {
		return err
	}
	return downloadAndExtract(ctx, assetURL, assetName, binDir)
}

func fetchLatestRelease(ctx context.Context, repo string) (ghRelease, error) {
	var release ghRelease
	url := fmt.Sprintf("https://api.github.com/repos/%s/releases/latest", repo)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return release, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return release, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return release, fmt.Errorf("github release lookup failed: %s", resp.Status)
	}
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return release, err
	}
	return release, nil
}

func selectAsset(release ghRelease, matchers [][]string) (string, string, error) {
	for _, asset := range release.Assets {
		name := strings.ToLower(asset.Name)
		for _, rule := range matchers {
			if matchAll(name, rule) {
				return asset.URL, asset.Name, nil
			}
		}
	}
	return "", "", errors.New("no matching release asset found")
}

func matchAll(name string, parts []string) bool {
	for _, part := range parts {
		if !strings.Contains(name, strings.ToLower(part)) {
			return false
		}
	}
	return true
}

func downloadAndExtract(ctx context.Context, url, filename, binDir string) error {
	tmpFile, err := os.CreateTemp("", "thunder-installer-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmpFile.Name())

	if err := downloadFile(ctx, url, tmpFile); err != nil {
		return err
	}

	if strings.HasSuffix(strings.ToLower(filename), ".zip") {
		return extractZip(tmpFile.Name(), binDir)
	}
	if strings.HasSuffix(strings.ToLower(filename), ".tar.gz") || strings.HasSuffix(strings.ToLower(filename), ".tgz") {
		return extractTarGz(tmpFile.Name(), binDir)
	}
	if strings.HasSuffix(strings.ToLower(filename), ".tar.xz") {
		return extractTarXz(tmpFile.Name(), binDir)
	}
	return errors.New("unsupported archive format")
}

func downloadToBin(ctx context.Context, url, name, binDir string) error {
	filename := name
	if runtime.GOOS == "windows" && !strings.HasSuffix(strings.ToLower(name), ".exe") {
		filename += ".exe"
	}
	dest := filepath.Join(binDir, filename)
	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer out.Close()
	if err := downloadFile(ctx, url, out); err != nil {
		return err
	}
	return ensureExecutable(dest)
}

func downloadFile(ctx context.Context, url string, out *os.File) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("download failed: %s", resp.Status)
	}
	_, err = io.Copy(out, resp.Body)
	return err
}

func extractZip(path, binDir string) error {
	reader, err := zip.OpenReader(path)
	if err != nil {
		return err
	}
	defer reader.Close()

	for _, file := range reader.File {
		if file.FileInfo().IsDir() {
			continue
		}
		name := filepath.Base(file.Name)
		if !shouldCopyBinary(name) {
			continue
		}
		if err := writeZipFile(file, filepath.Join(binDir, name)); err != nil {
			return err
		}
	}
	return nil
}

func writeZipFile(file *zip.File, dest string) error {
	in, err := file.Open()
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer out.Close()

	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return ensureExecutable(dest)
}

func extractTarGz(path, binDir string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()

	gz, err := gzipReader(file)
	if err != nil {
		return err
	}
	defer gz.Close()

	return extractTar(gz, binDir)
}

func extractTarXz(path, binDir string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()

	xzr, err := xz.NewReader(file)
	if err != nil {
		return err
	}
	return extractTar(xzr, binDir)
}

func extractTar(reader io.Reader, binDir string) error {
	tarReader := tar.NewReader(reader)
	for {
		header, err := tarReader.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if header.FileInfo().IsDir() {
			continue
		}
		name := filepath.Base(header.Name)
		if !shouldCopyBinary(name) {
			continue
		}
		dest := filepath.Join(binDir, name)
		out, err := os.Create(dest)
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, tarReader); err != nil {
			out.Close()
			return err
		}
		out.Close()
		if err := ensureExecutable(dest); err != nil {
			return err
		}
	}
}

func gzipReader(r io.Reader) (io.ReadCloser, error) {
	gr, err := gzip.NewReader(r)
	if err != nil {
		return nil, err
	}
	return gr, nil
}

func shouldCopyBinary(name string) bool {
	base := strings.ToLower(name)
	return base == "aria2c" || base == "aria2c.exe" ||
		base == "yt-dlp" || base == "yt-dlp.exe" ||
		base == "n_m3u8dl-re" || base == "n_m3u8dl-re.exe" ||
		base == "ffmpeg" || base == "ffmpeg.exe" ||
		base == "ffprobe" || base == "ffprobe.exe"
}

func ensureExecutable(path string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	return os.Chmod(path, 0o755)
}

func copyFromPath(name, binDir string) error {
	path, err := exec.LookPath(name)
	if err != nil {
		return err
	}
	return copyFile(path, filepath.Join(binDir, filepath.Base(path)))
}

func copyFile(src, dest string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return ensureExecutable(dest)
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

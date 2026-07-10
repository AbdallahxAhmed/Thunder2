"""Register the Thunder extension in Chromium browsers via the Windows Registry.

Generates a persistent RSA key pair (if not exists) to ensure a stable Extension ID,
adds the public key to manifest.json, and writes the extension path to the registry
for Google Chrome, Microsoft Edge, and Brave.
"""

from __future__ import annotations

import os
import sys
import json
import base64
import hashlib
import winreg
from pathlib import Path

# Setup paths
root_dir = Path(__file__).resolve().parent
manifest_path = root_dir / "extension" / "manifest.json"
key_pem_path = root_dir / "key.pem"

def log(msg: str):
    print(f"⚡ [Thunder Extension Installer] {msg}")

def ensure_key_and_manifest() -> tuple[str, str]:
    """Ensure RSA private key exists, generate if missing, and return base64 pubkey + extension id."""
    try:
        from Crypto.PublicKey import RSA
    except ImportError:
        log("Error: pycryptodome is not installed in this Python environment.")
        log("Please run this script using the virtual environment python:")
        log("  .venv\\Scripts\\python.exe register_extension.py")
        sys.exit(1)

    if not manifest_path.exists():
        log(f"Error: manifest.json not found at {manifest_path}")
        sys.exit(1)

    # 1. Generate or load RSA private key
    if not key_pem_path.exists():
        log("Generating new 2048-bit RSA key pair for a stable Extension ID...")
        key = RSA.generate(2048)
        key_pem = key.export_key(format='PEM')
        key_pem_path.write_bytes(key_pem)
        log(f"✔ Private key saved to {key_pem_path}")
    else:
        log("Loading existing key.pem...")
        key_pem = key_pem_path.read_bytes()
        key = RSA.import_key(key_pem)

    # 2. Get public key in DER format
    pub_der = key.publickey().export_key(format='DER')
    pub_b64 = base64.b64encode(pub_der).decode('utf-8')

    # 3. Calculate Extension ID
    # SHA-256 of the DER public key
    sha = hashlib.sha256(pub_der).hexdigest()
    # Map first 32 characters from hex (0-f) to letters (a-p)
    ext_id = "".join(chr(int(c, 16) + 97) for c in sha[:32])
    
    # 4. Write "key" value into manifest.json
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["key"] = pub_b64
    
    # Write formatted json
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    log(f"✔ manifest.json updated with stable key. Extension ID is: {ext_id}")
    
    return pub_b64, ext_id

def register_in_browser(browser_name: str, reg_key_path: str, ext_id: str, ext_path: str):
    """Write unpacked extension path to the Windows Registry for a browser."""
    try:
        # Open registry key under HKEY_CURRENT_USER (requires no admin privileges)
        key = winreg.CreateKeyEx(
            winreg.HKEY_CURRENT_USER,
            f"{reg_key_path}\\{ext_id}",
            0,
            winreg.KEY_SET_VALUE
        )
        # Write "path" and "version" values
        winreg.SetValueEx(key, "path", 0, winreg.REG_SZ, ext_path)
        winreg.SetValueEx(key, "version", 0, winreg.REG_SZ, "1.0")
        winreg.CloseKey(key)
        log(f"✔ Successfully registered in {browser_name} registry.")
    except Exception as e:
        log(f"❌ Failed to register in {browser_name}: {e}")

def main():
    log("Starting extension auto-registration...")
    pub_b64, ext_id = ensure_key_and_manifest()
    
    ext_folder = str(root_dir / "extension")
    
    # Browser Registry Targets
    targets = [
        ("Google Chrome", "Software\\Google\\Chrome\\Extensions"),
        ("Microsoft Edge", "Software\\Microsoft\\Edge\\Extensions"),
        ("Brave Browser", "Software\\BraveSoftware\\Brave-Browser\\Extensions")
    ]
    
    for browser, reg_path in targets:
        register_in_browser(browser, reg_path, ext_id, ext_folder)
        
    print("\n🎉 Auto-registration finished!")
    print("====================================")
    print("Important Next Steps:")
    print("1. Close and reopen your browser(s).")
    print("2. You will see a browser prompt asking to enable the 'Thunder' developer extension.")
    print("3. Click 'Enable' (or accept) to activate it.")
    print("====================================\n")

if __name__ == "__main__":
    main()

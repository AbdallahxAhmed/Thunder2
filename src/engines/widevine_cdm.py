"""Widevine CDM negotiation via pywidevine.

Uses a local .wvd (Widevine Device) file to:
1. Parse the PSSH to extract KIDs
2. Generate a CDM license challenge
3. Send the challenge to the license server with captured headers
4. Parse the license response to extract plaintext KID:KEY pairs

This module is the core of the License Proxy architecture (v2).
"""

from __future__ import annotations

import base64
import logging
from typing import Any

import requests
from pywidevine.cdm import Cdm
from pywidevine.device import Device
from pywidevine.pssh import PSSH

from src.config import settings

logger = logging.getLogger(__name__)


class WidevineCDM:
    """Negotiate Widevine licenses to extract plaintext KID:KEY pairs."""

    def __init__(self, wvd_path: str | None = None) -> None:
        self.wvd_path = wvd_path or settings.wvd_path
        self._device: Device | None = None
        self._cdm: Cdm | None = None

    def _ensure_cdm(self) -> Cdm:
        """Lazily load the Widevine device and create a CDM instance."""
        if self._cdm is None:
            if not self.wvd_path:
                raise FileNotFoundError(
                    "WVD_PATH is not configured. "
                    "Set WVD_PATH in .env to the path of your .wvd file."
                )
            self._device = Device.load(self.wvd_path)
            self._cdm = Cdm.from_device(self._device)
            logger.info(
                "Widevine CDM loaded from %s",
                self.wvd_path,
                extra={"event": "cdm.loaded"},
            )
        return self._cdm

    def negotiate_keys(
        self,
        pssh_b64: str,
        license_url: str,
        license_headers: dict[str, Any] | None = None,
    ) -> list[str]:
        """Negotiate with a license server and return KID:KEY pairs.

        Args:
            pssh_b64: Base64-encoded PSSH box from the extension.
            license_url: The license server URL captured from the page.
            license_headers: HTTP headers from the original license request
                             (Authorization tokens, cookies, etc.).

        Returns:
            A list of "KID:KEY" strings in lowercase hex.

        Raises:
            FileNotFoundError: If no .wvd file is configured.
            RuntimeError: If CDM negotiation or license parsing fails.
        """
        cdm = self._ensure_cdm()
        headers = dict(license_headers or {})

        # Parse PSSH
        try:
            pssh = PSSH(pssh_b64)
        except Exception as exc:
            raise RuntimeError(f"Failed to parse PSSH: {exc}") from exc

        # Open a CDM session
        session_id = cdm.open()

        try:
            # Generate challenge
            challenge = cdm.get_license_challenge(session_id, pssh)

            logger.info(
                "Sending CDM challenge to %s (%d bytes)",
                license_url,
                len(challenge),
                extra={"event": "cdm.challenge_sent"},
            )

            # Send challenge to license server
            response = requests.post(
                license_url,
                data=challenge,
                headers=headers,
                timeout=30,
            )
            response.raise_for_status()

            # Parse the license response
            cdm.parse_license(session_id, response.content)

            # Extract all content keys
            keys = []
            for key in cdm.get_keys(session_id):
                if key.type == "CONTENT":
                    kid_hex = key.kid.hex
                    key_hex = key.key.hex()
                    keys.append(f"{kid_hex}:{key_hex}")
                    logger.info(
                        "Key extracted — KID: %s",
                        kid_hex,
                        extra={"event": "cdm.key_extracted"},
                    )

            if not keys:
                raise RuntimeError(
                    "CDM negotiation succeeded but no CONTENT keys were found "
                    "in the license response"
                )

            logger.info(
                "CDM negotiation complete — %d key(s) extracted",
                len(keys),
                extra={"event": "cdm.negotiation_complete"},
            )
            return keys

        finally:
            cdm.close(session_id)


# Singleton
widevine_cdm = WidevineCDM()

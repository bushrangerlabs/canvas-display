from __future__ import annotations

import base64
from dataclasses import dataclass

import requests


@dataclass(frozen=True)
class TokenResponse:
    access_token: str
    token_type: str
    expires_in: int


def issue_token(
    *,
    client_id: str,
    client_secret: str,
    subject: str,
    scope: str = "",
    endpoint: str = "https://token-provider.api.listnr.com/v1/issue-token",
    timeout: float = 10.0,
) -> TokenResponse:
    """Issue a LiSTNR JWT via client-credentials flow.

    Docs: https://docs.api.listnr.com/services/token-provider/guides/issue-token
    """
    basic = base64.b64encode(f"{client_id}:{client_secret}".encode("utf-8")).decode("ascii")
    headers = {
        "Authorization": f"Basic {basic}",
        "Content-Type": "application/json",
    }
    payload = {
        "client_id": client_id,
        "subject": subject,
    }
    if scope.strip():
        payload["scope"] = scope.strip()

    response = requests.post(endpoint, headers=headers, json=payload, timeout=timeout)
    response.raise_for_status()

    body = response.json()
    return TokenResponse(
        access_token=body["access_token"],
        token_type=body.get("token_type", "Bearer"),
        expires_in=int(body.get("expires_in", 900)),
    )

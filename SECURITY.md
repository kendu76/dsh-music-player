# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x | ✅ |

## Reporting a vulnerability

Please report security issues privately through GitHub Security Advisories:

https://github.com/kendu76/dsh-music-player/security/advisories/new

Do not open a public issue for an undisclosed vulnerability. We aim to acknowledge reports within 7 days and will coordinate a fix and disclosure timeline with you.

## Scope

dsh-music-player is a DSH plugin with a host half (local file scanning/streaming, online music/radio APIs, TTS, news persistence) and a browser half. Security-relevant areas include credential/cookie handling under `~/.dsh`, local path handling, outbound HTTP requests, and the `/dsh-music/*` HTTP routes. Reports about these areas are welcome.

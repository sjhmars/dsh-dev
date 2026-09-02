# @deepseek-ai/dsh-external-gateway-deployment

English | [中文](README.zh.md)

## Summary

The External Gateway application is the deployment-facing home for the DSH machine gateway. It defines the application identity, launch command, loopback listener, and smoke expectations without adding another executable. The `dsh` CLI remains the only launcher, and the profile remains `dsh --profile external-gateway`.

## Start the application

Run the application through the installed `dsh` command:

```sh
dsh --profile external-gateway
```

The application listens on `127.0.0.1:18765`. Place an encrypted tunnel or TLS termination in front of this listener before a VPS client connects. The bearer token authenticates the client; it does not encrypt the transport.

## Loopback smoke

The focused application description in [`application.json`](application.json) records the health endpoint, loopback-only bind, and browser-route expectation. A smoke run must confirm that `/healthz` is reachable locally and that the browser `/api`, `/api/remote.mux`, and frontend routes are not exposed.

## Ownership

This directory owns deployment-facing application identity, usage instructions, and loopback smoke semantics. [`@deepseek-ai/dsh-external-gateway`](../../packages/interaction/external-gateway/README.md) owns protocol validation, authentication, Session access, and durable delivery. [`@deepseek-ai/dsh-external-gateway-app`](../../packages/bundle/external-gateway-app/README.md) owns the static profile patch that composes those services. The protocol vocabulary has one home in [`PROTOCOL.md`](../../packages/interaction/external-gateway/PROTOCOL.md).

The application package has no `bin` field. Do not start the runtime by importing a package entry or by adding a second Node executable.

## Further exploration

- [`dsh` CLI](../cli/README.md) — launcher grammar and profile initialization.
- [`external-gateway` protocol package](../../packages/interaction/external-gateway/README.md) — authenticated `/v1` behavior.
- [`external-gateway-app` bundle](../../packages/bundle/external-gateway-app/README.md) — Host composition and browser-surface isolation.

## Known limitations and deferred work

- The profile is loopback-only; cross-machine access requires an encrypted tunnel or TLS.
- This application directory does not provide a browser console, VPS bridge, QR binding, or iLink adapter.
- The DSH profile and its bundle remain the runtime source; this package publishes only the deployment description.

## Dev Note

The application description is intentionally small. It prevents deployment documentation and smoke checks from becoming a second owner of protocol or profile-patch details.

# patchix

https://github.com/user-attachments/assets/26bec6b0-91b5-4e26-b806-c3a54d0d6687

patchix runs fleets of agents to patch packages in [nixpkgs](https://github.com/NixOS/nixpkgs). It helps deploy vulnerability fixes at large scale, and works best for deploying a small fix among many packages.

The first campaign is [NixOS/nixpkgs#576541](https://github.com/NixOS/nixpkgs/issues/576541): packages with a bundled CA trust store. The check is [nix-cacert-harness](https://github.com/irgolic/nix-cacert-harness). It examines the trust stores of a package before and after the fix. It also tests the package with the certificate chains of the eMudhra incident.

> [!NOTE]
> **AI Disclosure**: Claude Code wrote most of this repository using a mix of Fable 5.1 and Opus 5.5. It is human-reviewed. The agent instructions, campaign prompts and the pull request descriptions are written in ASD-STE100 (Simplified Technical English), linted with [memelint](https://github.com/antimemes/memelint) in `strict` mode.

## Start

It's assumed you have an SSH key configured for pushing.

Create a GitHub classic token with the `public_repo` scope and put it in `~/.local/share/patchix/.env` as `GH_TOKEN=...`.

```sh
$(nix-build https://github.com/antimemes/patchix/archive/main.tar.gz --no-out-link)/bin/patchix
```

or, with flakes,

```sh
nix run github:antimemes/patchix
```

## On AI policy

patchix strongly abides by the [nixpkgs AI policy](https://github.com/NixOS/nixpkgs/blob/master/CONTRIBUTING.md#automationai-policy). Our goal is to accelerate incident response by helping maintainers rapidly review and build confidence in AI-generated output.

![The tick box before the `Create pull request` button](docs/create-pr-checkbox.gif)

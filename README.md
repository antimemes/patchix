# patchix

![A tour of the web page: the campaigns, the task list, one task with its diff and checks, and the pull request page](docs/tour.gif)

patchix starts fleets of agents that fix packages in [nixpkgs](https://github.com/NixOS/nixpkgs). It helps maintainers to deploy a fix for a vulnerability at a large scale: one small fix for each of many packages. A tracking issue gives the list of packages. A person can review each fix quickly, and a check gives the signal that the fix is correct.

The first campaign is [NixOS/nixpkgs#576541](https://github.com/NixOS/nixpkgs/issues/576541): packages with a bundled CA trust store. The check is [nix-cacert-harness](https://github.com/irgolic/nix-cacert-harness). It examines the trust stores of a package before and after the fix. It also tests the package with the certificate chains of the eMudhra incident.

> [!NOTE]
> **AI Disclosure**: Claude Code wrote most of this repository using a mix of Fable 5.1 and Opus 5.5. It is human-reviewed. The agent instructions, campaign prompts and the pull request descriptions are written in ASD-STE100 (Simplified Technical English), linted with [memelint](https://github.com/antimemes/memelint) in `strict` mode.

## Start

It's assumed you have an SSH key configured for pushing.

Create a GitHub classic token with the `public_repo` scope and in `~/.local/share/patchix/.env` as `GH_TOKEN=...`.

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

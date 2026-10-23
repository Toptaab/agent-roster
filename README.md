# agent-roster

A Claude Code mod: a live pane of every agent in the session, each one a pixel Clawd at work, with its tokens, status and current tool. Finished agents fold into a history below.

Each agent type carries its own prop: Explore a magnifier, Plan a hard hat, general-purpose a hammer, fork a laptop, teammate a cap; main goes plain. The terminal draws Clawd in quadrant blocks, the desktop app as an animated SVG.

## Install

It ships through the `toptaab-mods` marketplace, which lives in [Toptaab/token-garden](https://github.com/Toptaab/token-garden):

```
/plugin marketplace add Toptaab/token-garden
/plugin install agent-roster@toptaab-mods
/reload-plugins
```

From a shell:

```
claude plugin marketplace add Toptaab/token-garden
claude plugin install agent-roster@toptaab-mods
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `Toptaab/token-garden`, then Add plugin.

## Use

The pane opens at the start of a session where there is room for it. `/roster` opens it by hand; `/roster clear` drops the finished agents from the history.

## Develop

Run Claude Code against the working copy, from the repo root:

```
claude --plugin-dir .
```

The mod loads straight from disk, hot-reloads on save, and overrides the installed version for that session. Check it with `claude plugin validate .` and `claude plugin test .`.

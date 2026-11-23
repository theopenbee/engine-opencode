# openbee OpenCode engine

An [openbee](https://github.com/theopenbee/openbee) engine plugin that runs tasks with [OpenCode](https://opencode.ai). It is built on [`@theopenbee/engine-sdk`](https://www.npmjs.com/package/@theopenbee/engine-sdk).

## Requirements

You install OpenCode 2.0 or newer and connect a model provider yourself. The plugin only starts it.

```sh
curl -fsSL https://opencode.ai/install | bash
opencode auth login
```

Instead of `opencode auth login`, you can give OpenCode a provider key as an environment variable in openbee's **Env** settings (for example `DEEPSEEK_API_KEY`). openbee passes its environment, including these settings, to OpenCode.

The plugin itself needs Node.js 20 or newer (or Bun).

## Install

```sh
openbee plugin install opencode
```

Or from npm by package name:

```sh
openbee plugin install @theopenbee/engine-opencode
```

Or from a local checkout:

```sh
git clone https://github.com/theopenbee/engine-opencode.git
cd engine-opencode
npm install
openbee plugin install "$(pwd)"
```

Then enable the plugin, and pick `opencode` as the default engine or per worker.

## Settings

| Setting | Description |
|---|---|
| `path` | Path to the `opencode` executable. Leave empty to use `opencode` from `PATH`, or `~/.opencode/bin/opencode` where the install script puts it. |

The plugin checks the setting when it is enabled: it runs `opencode --version` and shows the version, or the reason it failed (for example `opencode not found on PATH`, or a version older than 2.0).

## Choosing a model

Set the worker's **Model** field, in OpenCode's `provider/model` form (for example `deepseek/deepseek-flash`). The plugin passes it to OpenCode as `--model <model>`, before the extra args. The suggested models come from `opencode models --standalone`, which lists the models of the providers OpenCode has a login or key for, so set the provider key in **Env** first.

`-m provider/model` in the worker's engine arguments still works; if the engine args already set a model with `-m` or `--model`, they win and the Model field is ignored. Without either, OpenCode uses the `model` from its own config.

## Sessions

Each openbee conversation maps to the OpenCode session `ses_<openbee session id>`. OpenCode creates it on the first message and continues it afterwards, so the plugin keeps no files of its own. Sessions live in OpenCode's database (`~/.local/share/opencode/`) and show up in OpenCode's session list.

Token usage is read with `opencode session export` and summed per `provider/model`. Reasoning tokens count as output tokens. Tokens that OpenCode counts for the session but not for any message, such as generating the session title, go to the session's model. Subagent sessions the run started are counted in the openbee session that started them.

## How it runs OpenCode

```
opencode run --standalone --auto --format json [--session ses_<id>] [--model <model>] [extra args]
```

- The prompt is written to OpenCode's standard input.
- `--standalone` runs a private OpenCode server for the run. OpenCode's shared background service would not see openbee's environment, so provider keys from **Env** and the MCP key would be lost.
- `--auto` approves tool permissions that are not explicitly denied in your OpenCode config.
- When openbee provides its MCP server, the plugin adds it through `OPENCODE_CONFIG_CONTENT` as a remote server that sends `Authorization: Bearer {env:OPENBEE_API_KEY}`. OpenCode expands the placeholder from its environment, so the API key never appears on the command line or in the config. An `OPENCODE_CONFIG_CONTENT` already set in openbee's environment is kept and the server is merged into it. It must then be plain JSON, without comments or trailing commas; otherwise the run fails instead of dropping your settings.
- Auto-update is disabled for runs started by openbee (`OPENCODE_DISABLE_AUTOUPDATE=1`).
- The result is the text of the last text part. A non-zero exit code, or an error event that no text follows, is reported as a failed run, with OpenCode's own message when it gave one.
- OpenCode's output is written to the run's log file as it arrives.

## Development

```sh
npm install
npm test
```

`npm install` also builds `dist/`; run `npm run build` after changing `src/`. The end-to-end tests run the plugin against a fake `opencode` script, under Node and under Bun when it is installed (`bun` on `PATH` or `~/.openbee/runtime/bun-*/bun`).

## License

MIT

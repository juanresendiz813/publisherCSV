<!--
Copyright (c) Credible Data Inc.
SPDX-License-Identifier: MIT
-->

# Scaffolding a package

> What this is: the finer points of `npm create @malloy-publisher/malloy-package`, the scaffolder the
> README's [Start from your own data](../README.md#start-from-your-own-data) uses. Read it when the
> short version left a question.

## Keep the `@latest`

`npm create` resolves the scaffolder through npm's npx cache. On a machine that has run the command
before, an unversioned name is satisfied by whatever copy is already cached, so npm never asks the
registry — and you can quietly scaffold from a months-old scaffolder that pins an older server than
the one you meant to run. The scaffolder checks its own version against the registry once it has
finished writing and tells you when it is behind; that check is bounded and fails open, is skipped
where `CI` or `NO_UPDATE_NOTIFIER` is set, and `CREATE_MALLOY_PACKAGE_NO_UPDATE_CHECK=1` turns it off
anywhere else.

## Make the directory first

The package lands in `./sales`, but the workspace around it is written to the current directory, so
running the command somewhere you did not mean to scatters config files through it. The workspace is:
start and reset scripts, an MCP config, agent instructions, and the Malloy agent skills as files your
agent can read. `npm start` runs the server version the scaffolder pinned, against your package, in
watch mode.

## Sample data, or your own

Run bare, the package comes with a small sample dataset, so there is something to query before you
have wired up anything of your own. `--data` seeds it from a file instead — CSV, Parquet, JSON,
newline-delimited JSON, or Excel `.xlsx`; DuckDB reads all of them in place, so nothing needs
converting. Any plain delimited file with a header row works:

```csv
order_id,category,amount
1001,Furniture,789
1002,Electronics,489.95
```

The path is relative to the directory you run the command in; the scaffolder copies the file into the
package, so the original stays where it is. Pasting `./orders.csv` verbatim fails if no such file
exists.

The `--` before `--data` is required. Without it, `npm create` reads `--data` as one of its own
options and only the filename reaches the scaffolder, as a stray argument, so it stops.

A seeded package starts from your own columns. The scaffolder reads the head of a CSV, JSON or NDJSON
file and writes a model over what it finds: a measure for each numeric column that is not an
identifier, and a view breaking the data down by each column with few enough distinct values to chart.
The profile it worked from is written into the model as a comment, so a wrong guess is visible rather
than buried, and `--no-profile` writes the row count and `overview` alone instead. Parquet and XLSX are
binary containers and are not read, so those still start at the row count. Either way the modelling
starts there, and that is the point at which pointing an agent at the workspace pays off.

## Beyond a local file

A package is just Malloy, so it is not limited to the file it was seeded from: point its model at a
[database connection](connections.md) your config defines and the same workspace serves a warehouse.
The directory is ordinary — commit it, move it, or hand it to someone else.

## Which config the server reads

With the workspace in place, the server serves your package rather than the bundled examples:
`npm start` points it at the `publisher.config.json` the scaffolder wrote, and a bare
`npx @malloy-publisher/server` run from this directory picks up the same file. The README's agent
walkthrough is written against the examples, so run that from a directory without this config.

## Without `npm create`

Call the package by its full name:

```bash
npx @malloy-publisher/create-malloy-package@latest sales --data ./orders.csv
```

The name is `create-malloy-package` here, where `npm create` takes the `malloy-package` shorthand. The
same caching applies, so `@latest` is worth keeping — and npx needs no separator: it forwards flags as
they are, so a `--` there leaves the flags after it to arrive as stray arguments.

# Tag Registry Rewards

Script to distribute rewards for the Address Tags TCRs, given a period and a stipend. It will send the tokens directly to the users. So, it should send these rewards in a chain with negligible gas fees, like Gnosis Chain.

## Installation

`cp .env.example .env; yarn`

Set the missing .env key variables

## Format

`yarn start --node <node> --mode <mode> --start <start_date> --end <end_date> --tags <tags_filename> --gas <gas_filename> --rewards <rewards_filename>`

Most variables have defaults set in the `.env` file. You should set the stipend in the `.env` to avoid mistyping it when you run the command. Same with the new-tag-ratio.

Dates are `YYYY-MM-DD` strings e.g. `2022-05-01`. If you don't pass them, they will default to the dates that enclose the past month.

There are three modes, that need different arguments. They are three steps, in order:

- `tags`, will get the awarded submissions and output some data to query gas used per contract.
- `rewards`, will create the csv file of the rewards, along with the transactions.
- `send`, will send the transactions.

## Fetching tags

Fetching the tags is the first step, and will not generate transactions. `--mode tags` will generate a txt file with some variables to paste in a Dune query. The Dune query will return a JSON file (use network tab), deep into this file there's a `data` property that will contain an array. This array must be copied and pasted into a new JSON file under the `files` directory, and will be used within the next command to obtain the gas used, to generate the rewards.

[Dune Query](https://dune.com/queries/3078126) 

## Generating rewards

Generating the rewards with `--mode rewards` is safe and won't generate transactions. It allows to inspect the rewards, and to share the rewards to the community before committing to send them. To do so, run the script with `--mode rewards --tags ${filename}.json --gas ${filename}.json`. It doesn't matter if this is run on `production` or `development`, as it won't send any transaction.

This will create a csv file you can export to a calc sheet with every reward detail, and a JSON and csv with the final transactions that will place. This JSON will be the one that you will use to distribute the rewards.

Things that could go wrong:

- Wrong stipend

Stipend is kept in the `.env`. That way, you only need to check them if there are any changes on how the rewards are distributed. At the current time, the stipend is 25_000 PNK, the amount awarded per registry and chain.

## Distributing rewards

`yarn start --mode send --rewards ${filename}.json`

Distribute the rewards on the testnet to make sure you don't mess up. Deploy a test ERC-20 contract in Sokol chain for this purpose, and set it on the `.env`.

You must pass a file containing the transactions with `--rewards filename.json`.

Note, the stipend is used here to revert if the stipend is greater than the current balance. It will not affect the transactions in any way, because they have alredy been generated.

If nothing went wrong, proceed with the real distribution.

`yarn start --mode send --node production --file ${filename}.json`

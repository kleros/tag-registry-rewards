# Tag Registry Rewards

Script to distribute rewards for the Address Tags TCRs, given a period and a stipend. It will send the tokens directly to the users. So, it should send these rewards in a chain with negligible gas fees, like Gnosis Chain.

## Installation

`cp .env.example .env; yarn`

Set the missing .env key variables

## Format

`yarn start --node <node> --mode <mode> --start <start_date> --end <end_date> --stipend <stipend> --new-tag-ratio <new-tag-ratio> --file <file>`

Most variables have defaults set in the `.env` file. You should set the stipend in the `.env` to avoid mistyping it when you run the command. Same with the new-tag-ratio.

Dates are `YYYY-MM-DD` strings e.g. `2022-05-01`. If you don't pass them, they will default to the dates that enclose the past month.

There are two modes, that need different arguments:
- `csv`, will create the csv file of the rewards, along with the transactions.
- `send`, will send the transactions.

## Generating rewards

Generating the rewards with `--mode csv` is safe and won't generate transactions. It allows to inspect the rewards, and to share the rewards to the community before committing to send them. To do so, run the script with `--mode csv`, and optionally pass extra parameters, although, you should just keep them in the `.env`. It doesn't matter if this is run on `production` or `development`, as it won't send any transaction.

This will create a csv file you can export to a calc sheet with every reward detail, and a JSON and csv with the final transactions that will place. This JSON will be the one that you will use to distribute the rewards. 

Things that could go wrong:
- Wrong stipend
- Wrong new tag ratio

I recommend to **not** pass these on the cli. Keep them in the `.env`. That way, you only need to check them if there are any changes on how the rewards are distributed.

## Distributing rewards

`yarn start --mode send --file ${filename}.json`

Distribute the rewards on the testnet to make sure you don't mess up. Deploy a test ERC-20 contract in Sokol chain for this purpose, and set it on the `.env`.

You must pass a file containing the transactions with `--file filename.json`.

Note, the stipend is used here to revert if the stipend is greater than the current balance. It will not affect the transactions in any way, because they have alredy been generated.

If nothing went wrong, proceed with the real distribution.

`yarn start --mode send --node production --file ${filename}.json`

## New tag ratio

The new tag ratio is the guaranteed minimum percentage allocated to tags that hadn't been tagged before in Etherscan. After obtaining the weights, if the actual ratio of new tags is under this ratio, the rewards will be generated in separate classes of rewards. Setting it to zero will distribute the rewards as before, without this bias.

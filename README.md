# Tag Registry Rewards

Script to distribute rewards for the Address Tags TCRs, given a period and a stipend. It will send the tokens directly to the users. So, it should send these rewards in a chain with negligible gas fees, like Gnosis Chain.

## Installation

`cp .env.example .env; yarn`

Set the missing .env key variables

## Format

`yarn start --node <node> --mode <mode> --start <start_date> --end <end_date> --stipend <stipend> --new-tag-ratio <new-tag-ratio>`

Most variables have defaults set in the `.env` file. You should set the stipend in the `.env` to avoid mistyping it when you run the command. Same with the new-tag-ratio.

Dates are `YYYY-MM-DD` strings e.g. `2022-05-01`. If you don't pass them, they will default to the dates that enclose the past month.

## Exporting rewards

Generating the rewards without distributing is safe. It allows to inspect the rewards, and it allows you to show the rewards to the community before committing to send them. To do so, run the script with `--mode csv`. It doesn't matter if this is run on `production` or `development`, as it won't send any transaction.

## Distributing rewards

`yarn start --mode send`

Distribute the rewards on the testnet to make sure you don't mess up. Deploy a test ERC-20 contract in Sokol chain for this purpose, and set it on the `.env`.

Things that can go wrong:
- Etherscan scraping not working
- Etherscan throttling
- Wrong stipend
- Wrong new tag ratio

You can't really test the stipend, so don't get it wrong. If you mistype it and there're not enough funds, the bot will refuse to distribute. If it's less, then it will go through, but you can do another distribution with the portion of the stipend you missed. So, the safest approach is to make sure the bot doesn't hold more than the supposed stipend.

If nothing went wrong, proceed with the real distribution.

`yarn start --node production --mode send`

## New tag ratio

The new tag ratio is the guaranteed minimum percentage allocated to tags that hadn't been tagged before in Etherscan. After obtaining the weights, if the actual ratio of new tags is under this ratio, the rewards will be generated in separate classes of rewards. Setting it to zero will distribute the rewards as before, without this bias.

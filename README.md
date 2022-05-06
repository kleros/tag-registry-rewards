# Tag Registry Rewards

Script to distribute rewards for the Address Tags TCRs, given a period and a stipend. It will send the tokens directly to the users. So, it should send these rewards in a chain with negligible gas fees, like Gnosis Chain.

## Installation

`cp .env.example .env; yarn`

Set the .env key variables

## Distributing rewards

Go to .env and set the START_DATE, END_DATE, STIPEND. Remember that PNK has 18 decimal digits, so you should append 18 zeroes to the human friendly amount.

Distribute the rewards on the testnet to make sure you don't mess up. [This is a test ERC-20 token in Kovan for this purpose.](https://kovan.etherscan.io/address/0xaFF4481D10270F50f203E0763e2597776068CBc5#writeContract) Call the `drip()` function. Change PNK in the .env to this token, change the stipend, and set the NODE_ENV to `development`. The env variables below are suited for this test. Note the stipend is lower than what you will distribute.

```
PNK=0xaFF4481D10270F50f203E0763e2597776068CBc5
STIPEND=1000000000000000000000
NODE_ENV=development
```

Things that can go wrong:
- Etherscan scraping not working
- Etherscan throttling
- Wrong stipend
- Not enough funds

You can't really test the stipend, so don't get it wrong. If you mistype it and there're not enough funds, the bot will refuse to distribute. If it's less, then it will go through, but you can do another distribution with the portion of the stipend you missed.

If nothing went wrong, proceed with the real distribution. The stipend below is for 100k PNK, and the token is for stPNK.

```
PNK=0xcb3231aBA3b451343e0Fddfc45883c842f223846
STIPEND=100000000000000000000000
NODE_ENV=production
```

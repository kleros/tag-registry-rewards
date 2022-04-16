/**
 * 1. get all items that are currently registered with last update in period
 * 2. if dupes in that period (e.g. submitted to both tcrs) get earliest. cast to tag
 * 3. per Tag, check contract gas usage in etherscan api. if contract, cast to ContractInfo
 * 4. figure out the weight of each ContractInfo (do sqrt of each, then store proportion)
 * 5. figure out the reward by multiplying proportion by total monthly expenditure. cast to Reward
 * 6. per Reward, send the reward, then immediately file the reward as sent in db.
 * 7. finish process.
 */

import { Period } from "./types";

const buildRewards = async (period: Period) => {

}
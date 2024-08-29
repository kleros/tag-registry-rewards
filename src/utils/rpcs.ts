// vestigial purpose: check if something is a contract.
// now, it's just used to check if chain is awarded or not
// if ever non-evm contracts are awarded, refactor this to caip10 "chainIds"
// that is, namespace:reference
// note other parts of the code making evm assumptions will also need refactoring
// (e.g. checking if address is contract, assumes evm)
// the rpcs are currently NOT being used!
export const chainIdToRpc: { [chainId: string]: string } = {
  // "1": "https://eth.llamarpc.com",
  "100": "https://rpc.gnosischain.com",
  // "137": "https://polygon-rpc.com",
  // "56": "https://bsc-dataseed1.binance.org",
  // "42161": "https://arbitrum.llamarpc.com",
  // "10": "https://op-pokt.nodies.app",
  "324": "https://1rpc.io/zksync2-era",
  "43114": "https://avalanche.drpc.org",
  // "42220": "https://forno.celo.org",
  // "8453": "https://base.meowrpc.com",
  "250": "https://1rpc.io/ftm",
  "534352": "https://rpc.scroll.io",
}

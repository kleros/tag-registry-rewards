// these chains are considered rewarded by the curate incentive program,
// if any chain becomes unrewarded by the program, make sure to comment that chain here,
// and the script will exclude it from the rewards.

export const chains = [
  {
    id: '100',
    namespaceId: 'eip155',
    name: 'Gnosis Chain',
    label: 'GNO',
    explorer: 'gnosisscan.io',
    rpc: 'https://rpc.gnosischain.com'
  },
  {
    id: '324',
    namespaceId: 'eip155',
    name: 'zkSync Mainnet',
    label: 'zkSync',
    explorer: 'era.zksync.network',
    rpc: 'https://1rpc.io/zksync2-era'
  },
  {
    id: '43114',
    namespaceId: 'eip155',
    name: 'Avalanche C-Chain',
    label: 'AVAX',
    explorer: 'snowscan.xyz',
    rpc: 'https://avalanche.drpc.org'
  },
  {
    id: '42220',
    namespaceId: 'eip155',
    name: 'Celo',
    label: 'CELO',
    explorer: 'celoscan.io',
    rpc: 'https://forno.celo.org'
  },
  {
    id: '8453',
    namespaceId: 'eip155',
    name: 'Base Mainnet',
    label: 'Base',
    explorer: 'basescan.org',
    rpc: 'https://base.meowrpc.com'
  },
  // {
  //   id: '250',
  //   namespaceId: 'eip155',
  //   name: 'Fantom Opera',
  //   label: 'FTM',
  //   explorer: 'ftmscan.com',
  //   rpc: 'https://1rpc.io/ftm'
  // },
  {
    id: '534352',
    namespaceId: 'eip155',
    name: 'Scroll',
    label: 'Scroll',
    explorer: 'scrollscan.com',
    rpc: 'https://rpc.scroll.io'
  },
  {
    id: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    namespaceId: 'solana',
    name: 'Solana',
    label: 'SOL',
    explorer: 'solscan.io',
    rpc: 'https://api.mainnet-beta.solana.com'
  },
  {
    id: '1',
    namespaceId: 'eip155',
    name: 'Ethereum Mainnet',
    label: 'ETH',
    explorer: 'etherscan.io',
    rpc: 'https://eth.llamarpc.com'
  },
  // {
  //   id: '137',
  //   namespaceId: 'eip155',
  //   name: 'Polygon',
  //   label: 'MATIC',
  //   explorer: 'polygonscan.com',
  //   rpc: 'https://polygon-rpc.com'
  // },
  // {
  //   id: '56',
  //   namespaceId: 'eip155',
  //   name: 'Binance Smart Chain',
  //   label: 'BNB',
  //   explorer: 'bscscan.com',
  //   rpc: 'https://bsc-dataseed1.binance.org'
  // },
  {
    id: '42161',
    namespaceId: 'eip155',
    name: 'Arbitrum One',
    label: 'ARB',
    explorer: 'arbiscan.io',
    rpc: 'https://arbitrum.llamarpc.com'
  },
  {
    id: '10',
    namespaceId: 'eip155',
    name: 'Optimism',
    label: 'OP',
    explorer: 'optimistic.etherscan.io',
    rpc: 'https://op-pokt.nodies.app'
  },
  {
    id: '59144',
    namespaceId: 'eip155',
    name: 'Linea',
    label: 'Linea',
    explorer: 'lineascan.build',
    rpc: 'https://rpc.linea.build'
  }
]

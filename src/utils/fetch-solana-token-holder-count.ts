import fetch from 'node-fetch';

export const getSolanaTokenHolderCount = async (tokenAddress: string, apiKey: string) => {
  const url = `https://api.helius.xyz/v0/tokens/${tokenAddress}/holders`;
  const headers = { 'X-API-KEY': apiKey };
  const response = await fetch(url, { headers });
  const data = await response.json();
  return data.total;
};
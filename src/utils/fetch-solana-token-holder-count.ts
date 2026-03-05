import fetch from 'node-fetch';

export const getSolanaTokenHolderCount = async (tokenAddress: string, apiKey: string): Promise<number> => {
  const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  let page = 1;
  const allOwners = new Set<string>();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "getTokenAccounts",
        id: "helius-test",
        params: {
          page,
          limit: 1000,
          displayOptions: {},
          mint: tokenAddress,
        },
      }),
    });

    if (!response.ok) {
      console.log(`Helius API error (status ${response.status}) for ${tokenAddress}`)
      return 0;
    }

    const data = await response.json() as { result?: { token_accounts: { owner: string }[] } };

    if (!data.result?.token_accounts?.length) break;

    for (const account of data.result.token_accounts) {
      allOwners.add(account.owner);
    }

    // We only need to know if it's above the threshold, no need to fetch all pages
    if (allOwners.size >= 5000) break;

    page++;
  }

  return allOwners.size;
};

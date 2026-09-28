# base-heartbeat-bo

**Status: retired.** This bot is not running and is not maintained.

It was written for a previous GBLIN index contract
(`0x36C81d7E1966310F305eA637e761Cf77F90852f0`) and its two pools on Uniswap V3 and Aerodrome.
It called `refreshWeights()` and `incentivizedRebalance()` on that contract, bought through its
pools and through `buyGBLIN`, and checked that the x402 endpoints answered.

The GBLIN vault in service, `0xc2181d975c05c8c724b334bcED0764c0b86B1D53`, needs none of this:

- it has no `incentivizedRebalance` and pays no keeper bounty; it rebalances through a Dutch
  auction that anyone, including CoW Protocol solvers, can fill;
- it refreshes its weights inside every mint, redemption and auction fill.

The code is kept for reference. Do not point it at the vault in service: its addresses, function
selectors and pool routes belong to the previous contract.

Current documentation: [GBLIN-Protocol](https://github.com/gblinproject/GBLIN-Protocol) (the
specification of the vault in service) and [gblin.digital/agents](https://gblin.digital/agents).

MIT © GBLIN Protocol

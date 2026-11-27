# ReserveConfig of each coin in Iora's own Blend pool (testnet). Sourced by deploy-blend-pool.sh,
# queue-blend-rates.sh and apply-blend-rates.sh. Rates and factors use 7 decimals (1e7 = 100%).
#
# Blend v2 borrow rate at utilisation u (times ir_mod, which drifts towards keeping u at `util`):
#   u <= util:        r_base + r_one * u/util
#   util < u <= 95%:  r_base + r_one + r_two * (u-util)/(95%-util)
#   u > 95%:          the above + r_three * (u-95%)/5%
# Supply rate = borrow rate x u x (1 - backstop take rate 10%).
#
# Since 2026-11-27 (queued; applied a week later with apply-blend-rates.sh). Shape from mainnet Blend's FixedV2
# pool (CAJJ..BXBD, read 2026-11-27): USDC util 80% max 90% r_base 3% r_one 4% r_two 12% r_three 500% react 20;
# XLM util 40% max 70% r_base 1% r_one 3% r_two 30% r_three 500% react 50. Changed for Iora's targets:
#   USDC: util 65% (the borrower bot keeps 60-70%), r_base 5% + r_one 7% = 12% borrow at target
#         -> supply ~7.0% at 65% (6.2% at 60%, 9.1% at 70%). max_util 90% keeps 10% cash for withdrawals.
#   XLM:  util 30%, r_base 3% + r_one 8% = 11% borrow at target -> supply ~3.0% at 30%. max_util 70%.
#   wETH: unchanged since the pool was set up (Blend TestnetV2 values).
I128MAX=170141183460469231731687303715884105727
rcfg() { # c_factor l_factor util max_util r_base r_one r_two r_three reactivity
  printf '{"index":0,"decimals":7,"c_factor":%s,"l_factor":%s,"util":%s,"max_util":%s,"r_base":%s,"r_one":%s,"r_two":%s,"r_three":%s,"reactivity":%s,"supply_cap":"%s","enabled":true}' "$@" "$I128MAX"
}
CFG_USDC=$(rcfg 9500000 9500000 6500000 9000000 500000 700000 1200000 50000000 20)
CFG_XLM=$(rcfg 7500000 7500000 3000000 7000000 300000 800000 3000000 50000000 50)
CFG_WETH=$(rcfg 8500000 8000000 6000000 9500000 7000 500000 3000000 15000000 200)

# Iora's own test coins (scripts/create-iora-coins.sh; queued 2026-11-27). Mainnet Blend's official v2 pools
# (FixedV2, YieldBloxV2, read 2026-11-27) list no BTC, ETH or SOL; their volatile asset is XLM (c/l 0.75, util
# 40-50%, max_util 70%, r_base 1%, r_one 3-4%, r_two 30%, r_three 500%). BTC and ETH take that shape with
# factors 0.80 (between mainnet XLM 0.75 and Blend TestnetV2 wBTC 0.90 / wETH 0.85), SOL is more volatile (0.65).
# EURC is FixedV2's EURC reserve as it is. Supply caps limit what a coin we can mint ourselves can do in the pool
# (the issuer could otherwise post any amount as collateral): about 100k USD each.
rcfgc() { # c_factor l_factor util max_util r_base r_one r_two r_three reactivity supply_cap
  printf '{"index":0,"decimals":7,"c_factor":%s,"l_factor":%s,"util":%s,"max_util":%s,"r_base":%s,"r_one":%s,"r_two":%s,"r_three":%s,"reactivity":%s,"supply_cap":"%s","enabled":true}' "$@"
}
CFG_BTC=$(rcfgc 8000000 8000000 4500000 8000000 100000 400000 3000000 50000000 20 15000000)        # cap 1.5 BTC
CFG_ETH=$(rcfgc 8000000 8000000 4500000 8000000 100000 400000 3000000 50000000 20 600000000)       # cap 60 ETH
CFG_SOL=$(rcfgc 6500000 6500000 4000000 7000000 100000 500000 3000000 50000000 20 15000000000)     # cap 1500 SOL
CFG_EURC=$(rcfgc 9500000 9500000 8000000 9000000 300000 400000 1200000 50000000 20 1000000000000)  # cap 100k EURC
COIN_SYMBOLS="BTC ETH SOL EURC"

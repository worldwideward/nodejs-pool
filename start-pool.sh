#!/bin/sh

export PATH=$PATH:/src/pool/node_modules/.bin

DATE_FORMAT="YYYY-MM-DD HH:mm:ss:SSS Z"
TIMEOUT="10000"

#pm2 start /src/monero/build/release/bin/monero-wallet-rpc -- \
#	--rpc-bind-port 18082 \
#	--password-file /home/node/wallets/wallet_pass \
#	--wallet-file /home/node/wallets/wallet \
#	--trusted-daemon \
#	--disable-rpc-login

pm2 start init.js --name=api \
	--log-date-format="$DATE_FORMAT" \
	-- --module=api

pm2 start init.js --name=blockManager \
	--kill-timeout=$TIMEOUT \
	--log-date-format="$DATE_FORMAT"  -- \
	--module=blockManager

pm2 start init.js --name=worker \
       	--kill-timeout=$TIMEOUT \
	--log-date-format="$DATE_FORMAT" \
	--node-args="--max_old_space_size=8192" -- \
	--module=worker

pm2 start init.js --name=payments \
	--kill-timeout=$TIMEOUT \
	--log-date-format="$DATE_FORMAT" \
	--no-autorestart -- \
	--module=payments

pm2 start init.js --name=remoteShare \
	--kill-timeout=$TIMEOUT \
	--log-date-format="$DATE_FORMAT" -- \
	--module=remoteShare

pm2 start init.js --name=longRunner \
	--kill-timeout=$TIMEOUT \
	--log-date-format="$DATE_FORMAT" -- \
	--module=longRunner

pm2 start init.js --name=pool_stats \
	--kill-timeout=$TIMEOUT \
	--log-date-format="$DATE_FORMAT" -- \
	--module=pool_stats

pm2 start init.js --name=pool \
	--kill-timeout=$TIMEOUT \
	--log-date-format="$DATE_FORMAT" -- \
	--module=pool

pm2 logs

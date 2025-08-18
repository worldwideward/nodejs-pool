FROM node:20-bullseye

RUN apt update && apt install -y \
	git \
	make \
	g++ \
	cmake \
	libssl-dev \
	libunbound-dev \
	libboost-dev \
	libboost-system-dev \
	libboost-date-time-dev \
	libboost-dev \
	libboost-system-dev \
	libboost-date-time-dev \
	libboost-filesystem-dev \
	libboost-thread-dev \
	libboost-chrono-dev \
	libboost-locale-dev \
	libboost-regex-dev \
	libboost-regex-dev \
	libboost-program-options-dev \
	libzmq3-dev

## Make sure you have enough RAM and Swap enabled

WORKDIR /src

RUN git clone https://github.com/monero-project/monero.git && \
	git clone https://github.com/Venemo/node-lmdb.git

WORKDIR /src/monero

RUN git checkout v0.18.4.1 && git submodule update --init && USE_SINGLE_BUILDDIR=1 make -j1 release

WORKDIR /src/node-lmdb

RUN git checkout c3135a3809da1d64ce1f0956b37b618711e33519 && \
	cd dependencies/lmdb/libraries/liblmdb && \
	make -j1

WORKDIR /src/pool

COPY package.json .

RUN npm i pm2 && npm i

COPY lib lib
COPY block_share_dumps block_share_dumps
COPY manage_scripts manage_scripts
COPY user_scripts user_scripts

COPY init.js .
COPY init_mini.js .

COPY coinConfig.json .
COPY config.json .


COPY block_notify.sh .
COPY fix_daemon.sh .
COPY start-pool.sh /usr/local/bin/start-pool

CMD ["start-pool"]

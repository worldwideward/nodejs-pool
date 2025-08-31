USE pool;
ALTER DATABASE pool DEFAULT CHARACTER SET utf8 COLLATE utf8_general_ci;
CREATE TABLE `balance` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `last_edited` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `payment_address` varchar(128) DEFAULT NULL,
  `payment_id` varchar(128) DEFAULT NULL,
  `pool_type` varchar(64) DEFAULT NULL,
  `bitcoin` tinyint(1) DEFAULT NULL,
  `amount` bigint(26) DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `balance_id_uindex` (`id`),
  UNIQUE KEY `balance_payment_address_pool_type_bitcoin_payment_id_uindex` (`payment_address`,`pool_type`,`bitcoin`,`payment_id`),
  KEY `balance_payment_address_payment_id_index` (`payment_address`,`payment_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
CREATE TABLE `paid_blocks` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `paid_time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `found_time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `port` int NOT NULL,
  `hex` varchar(128) NOT NULL,
  `amount` bigint(20) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `paid_blocks_paid_time` (`paid_time`),
  UNIQUE KEY `paid_blocks_hex` (`hex`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
CREATE TABLE `block_balance` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `hex` varchar(128) NOT NULL,
  `payment_address` varchar(128) DEFAULT NULL,
  `payment_id` varchar(128) DEFAULT NULL,
  `amount` float(53) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `block_balance_id_uindex` (`id`),
  UNIQUE KEY `block_balance_hex_payment_address_payment_id_uindex` (`hex`, `payment_address`,`payment_id`),
  KEY `block_balance_hex_index` (`hex`),
  KEY `block_balance_payment_address_payment_id_index` (`payment_address`,`payment_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
CREATE TABLE `bans` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `ip_address` varchar(40) DEFAULT NULL,
  `mining_address` varchar(200) DEFAULT NULL,
  `reason` varchar(200) DEFAULT NULL,
  `active` tinyint(1) DEFAULT '1',
  `ins_time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `bans_id_uindex` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
CREATE TABLE `notifications` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `mining_address` varchar(200) DEFAULT NULL,
  `message` varchar(200) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `notifications_id_uindex` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
CREATE TABLE `config` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `module` varchar(32) DEFAULT NULL,
  `item` varchar(32) DEFAULT NULL,
  `item_value` mediumtext,
  `item_type` varchar(64) DEFAULT NULL,
  `Item_desc` varchar(512) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `config_id_uindex` (`id`),
  UNIQUE KEY `config_module_item_uindex` (`module`,`item`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
CREATE TABLE `payments` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `unlocked_time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `paid_time` timestamp NOT NULL DEFAULT '1970-01-01 00:00:01',
  `pool_type` varchar(64) DEFAULT NULL,
  `payment_address` varchar(125) DEFAULT NULL,
  `transaction_id` int(11) DEFAULT NULL COMMENT 'Transaction ID in the transactions table',
  `bitcoin` tinyint(1) DEFAULT '0',
  `amount` bigint(20) DEFAULT NULL,
  `block_id` int(11) DEFAULT NULL,
  `payment_id` varchar(128) DEFAULT NULL,
  `transfer_fee` bigint(20) DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `payments_id_uindex` (`id`),
  KEY `payments_transactions_id_fk` (`transaction_id`),
  KEY `payments_payment_address_payment_id_index` (`payment_address`,`payment_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
CREATE TABLE `pools` (
  `id` int(11) NOT NULL,
  `ip` varchar(72) NOT NULL,
  `last_checkin` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `active` tinyint(1) NOT NULL,
  `blockID` int(11) DEFAULT NULL,
  `blockIDTime` timestamp NULL DEFAULT NULL,
  `hostname` varchar(128) DEFAULT NULL,
  `port` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `pools_id_uindex` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
CREATE TABLE `pool_workers` (
  `id` tinyint(1) unsigned NOT NULL AUTO_INCREMENT,
  `pool_id` int(11) NOT NULL,
  `worker_id` int(11) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `pool_workers_id_uindex` (`pool_id`, `worker_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
CREATE TABLE `port_config` (
  `poolPort` int(11) NOT NULL,
  `difficulty` int(11) DEFAULT '1000',
  `portDesc` varchar(128) DEFAULT NULL,
  `portType` varchar(16) DEFAULT NULL,
  `hidden` tinyint(1) DEFAULT '0',
  `ssl` tinyint(1) DEFAULT '0',
  PRIMARY KEY (`poolPort`),
  UNIQUE KEY `port_config_poolPort_uindex` (`poolPort`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
CREATE TABLE `ports` (
  `pool_id` int(11) DEFAULT NULL,
  `network_port` int(11) DEFAULT NULL,
  `starting_diff` int(11) DEFAULT NULL,
  `port_type` varchar(64) DEFAULT NULL,
  `description` varchar(256) DEFAULT NULL,
  `hidden` tinyint(1) DEFAULT '0',
  `ip_address` varchar(256) DEFAULT NULL,
  `lastSeen` timestamp NULL DEFAULT NULL,
  `miners` int(11) DEFAULT NULL,
  `ssl_port` tinyint(1) DEFAULT '0'
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
CREATE TABLE `shapeshiftTxn` (
  `id` varchar(64) NOT NULL,
  `address` varchar(128) DEFAULT NULL,
  `paymentID` varchar(128) DEFAULT NULL,
  `depositType` varchar(16) DEFAULT NULL,
  `withdrawl` varchar(128) DEFAULT NULL,
  `withdrawlType` varchar(16) DEFAULT NULL,
  `returnAddress` varchar(128) DEFAULT NULL,
  `returnAddressType` varchar(16) DEFAULT NULL,
  `txnStatus` varchar(64) DEFAULT NULL,
  `amountDeposited` bigint(26) DEFAULT NULL,
  `amountSent` float DEFAULT NULL,
  `transactionHash` varchar(128) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `shapeshiftTxn_id_uindex` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
CREATE TABLE `transactions` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `bitcoin` tinyint(1) DEFAULT NULL,
  `address` varchar(128) DEFAULT NULL,
  `payment_id` varchar(128) DEFAULT NULL,
  `xmr_amt` bigint(26) DEFAULT NULL,
  `btc_amt` bigint(26) DEFAULT NULL,
  `transaction_hash` varchar(128) DEFAULT NULL,
  `submitted_time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `mixin` int(11) DEFAULT NULL,
  `fees` bigint(26) DEFAULT NULL,
  `payees` int(11) DEFAULT NULL,
  `exchange_rate` bigint(26) DEFAULT NULL,
  `confirmed` tinyint(1) DEFAULT NULL,
  `confirmed_time` timestamp NULL DEFAULT NULL,
  `exchange_name` varchar(64) DEFAULT NULL,
  `exchange_txn_id` varchar(128) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `transactions_id_uindex` (`id`),
  KEY `transactions_shapeshiftTxn_id_fk` (`exchange_txn_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
CREATE TABLE `users` (
  `id` int(11) unsigned NOT NULL AUTO_INCREMENT,
  `username` varchar(256) NOT NULL,
  `pass` varchar(64) DEFAULT NULL,
  `email` varchar(256) DEFAULT NULL,
  `admin` tinyint(1) DEFAULT '0',
  `payout_threshold` bigint(16) DEFAULT '0',
  `enable_email` tinyint(1) DEFAULT '1',
  `payout_threshold_lock` tinyint(1) DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `users_id_uindex` (`id`),
  UNIQUE KEY `users_username_uindex` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
CREATE TABLE `xmrtoTxn` (
  `id` varchar(64) NOT NULL,
  `address` varchar(128) DEFAULT NULL,
  `paymentID` varchar(128) DEFAULT NULL,
  `depositType` varchar(16) DEFAULT NULL,
  `withdrawl` varchar(128) DEFAULT NULL,
  `withdrawlType` varchar(16) DEFAULT NULL,
  `returnAddress` varchar(128) DEFAULT NULL,
  `returnAddressType` varchar(16) DEFAULT NULL,
  `txnStatus` varchar(64) DEFAULT NULL,
  `amountDeposited` bigint(26) DEFAULT NULL,
  `amountSent` float DEFAULT NULL,
  `transactionHash` varchar(128) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `xmrtoTxn_id_uindex` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

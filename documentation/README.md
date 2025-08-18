# Documentation

Here you find detailed documentation on how to install, configure and run the mining pool.

This was written during the reverse engineering of the code.

##  Configuration

Most configuration is kept in the database. Initial configuration is set using the `base.sql` script. The file is loaded using mariadb entrypoint (see "Deployment with Docker").

You can adjust the configuration directly in the database:

```bash
user@host$ docker exec -it monero-pool-database-1 bash
container$ mariadb -u ocean -p

MariaDb [(none)]> use ocean;
MariaDb [pool]> show tables;
MariaDb [pool]> select * from config where module = 'general';
MariaDb [pool]> update config set item_value = 'xyz' where item = 'cmcKey';
```

### Using a trusted remote node

If you use a remote node, make sure you trust it. Typically you will run this node yourself in a location separate from the pool.

```bash
MariaDb [pool]> select * from config where module = 'wallet';
MariaDb [pool]> update config set item_value = 'node.example.com' where item = 'address';
MariaDb [pool]> update config set item_value = '18082' where item = 'port';
```

## Deployment with Docker

The deploy script `deployment/deploy.bash` was untangled to make the pool easier to deploy in a containerized environment.

To install the pool with docker run the following commands:

```bash
docker compose build # builds the nodejs-pool docker image
docker compose up
```

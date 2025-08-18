# Documentation

Here you find detailed documentation on how to install, configure and run the mining pool.

This was written during the reverse engineering of the code.

## Deployment with Docker

The deploy script `deployment/deploy.bash` was untangled to make the pool easier to deploy in a containerized environment.

To install the pool with docker run the following commands:

```bash
docker compose build # builds the nodejs-pool docker image
docker compose up
```

## Mysql database schema

Set the name of your database in `deployment/base.sql`, typically the name is the one defined in `docker-compose.yml`:

```yaml
  ...
  moneroocean-mysql:
    image: mariadb:11
    environment:
      MARIADB_ROOT_PASSWORD: "development"
      MARIADB_USER: "ocean"
      MARIADB_PASSWORD: "development"
      MARIADB_DATABASE: "ocean"
    volumes:
    - ./data/mariadb:/var/lib/mariadb
```

In the case of this example your database name is "ocean", so the command would be:

`sed -i s/__POOL_DB__/ocean/ deployment/base.sql`

Copy the schema to the running container:

`docker cp base.sql moneroocean-mysql:/`

Exec into the container and import the schema:

```bash
user@host$ docker exec -it moneroocean-mysql bash

container$ mariadb -u ocean -p < /base.sql
```

(TO DO: the file can also be loaded using mariadb entrypoint)

##  Configuration

Most configuration is kept in the database. Initial configuration is set using the `base.sql` script.

You can adjust the configuration directly in the database:

```bash
user@host$ docker exec -it moneroocean-mysql bash

container$ mariadb -u ocean -p

MariaDb [(none)]> use ocean;
MariaDb [ocean]> show tables;
MariaDb [ocean]> select * from config where module = 'general';
MariaDb [ocean]> update config set item_value = 'xyz' where item = 'cmcKey';
```

### Using a trusted remote node

If you use a remote node, make sure you trust it. Typically you will run this node yourself in a location separate from the pool.

```bash
user@host$ docker exec -it moneroocean-mysql bash

container$ mariadb -u ocean -p

MariaDb [(none)]> use ocean;
MariaDb [ocean]> show tables;
MariaDb [ocean]> select * from config where module = 'wallet';
MariaDb [ocean]> update config set item_value = 'node.example.com' where item = 'address';
MariaDb [ocean]> update config set item_value = '18082' where item = 'port';
```



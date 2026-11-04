#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
prepare_only=false
if [[ $# -gt 1 || ( $# -eq 1 && $1 != --prepare-only ) ]]; then echo 'Usage: scripts/test-database-mysql.sh [--prepare-only]' >&2; exit 2; fi
if [[ $# -eq 1 ]]; then prepare_only=true; fi
repo=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
fixture=$(mktemp -d /tmp/gram-db-fixture.XXXXXXXX)
run_id=$(basename -- "$fixture" | cut -d. -f2)
trap 'echo "Database fixture failed; private evidence retained at $fixture" >&2' ERR
mkdir -m 0755 "$fixture/certs"
mkdir -m 0700 "$fixture/secrets"
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 2 -subj /CN=GramDisposableDatabaseFixtureCA -keyout "$fixture/ca-key.pem" -out "$fixture/certs/ca.pem" >"$fixture/tls.log" 2>&1
openssl req -newkey rsa:2048 -nodes -sha256 -subj /CN=localhost -keyout "$fixture/certs/server-key.pem" -out "$fixture/server.csr" >>"$fixture/tls.log" 2>&1
printf '%s\n' 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1' 'extendedKeyUsage=serverAuth' >"$fixture/server.ext"
openssl x509 -req -sha256 -days 2 -in "$fixture/server.csr" -CA "$fixture/certs/ca.pem" -CAkey "$fixture/ca-key.pem" -CAcreateserial -extfile "$fixture/server.ext" -out "$fixture/certs/server-cert.pem" >>"$fixture/tls.log" 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 2 -subj /CN=UntrustedDatabaseFixtureCA -keyout "$fixture/untrusted-key.pem" -out "$fixture/certs/untrusted-ca.pem" >>"$fixture/tls.log" 2>&1
chmod 0444 "$fixture/certs/"*.pem
python3 - "$fixture" <<'PY'
import secrets,sys
from pathlib import Path
root=Path(sys.argv[1])
for engine in ['mysql','mariadb']:
    passwords={role:secrets.token_hex(24) for role in ['admin','readonly','writer']}
    prefix='MYSQL' if engine=='mysql' else 'MARIADB'
    (root/(engine+'.env')).write_text(prefix+'_ROOT_PASSWORD='+passwords['admin']+'\n'+prefix+'_ROOT_HOST=%\n')
    (root/(engine+'-client.env')).write_text('MYSQL_PWD='+passwords['admin']+'\n')
    for role,name in [('admin','fixture-admin-'+engine),('readonly','database-readonly-'+engine+'-fixture'),('writer','database-readonly-'+engine+'-writer')]:
        (root/'secrets'/name).write_text(passwords[role])
    values=','.join('('+str(i)+')' for i in range(1000))
    sql="CREATE DATABASE gram_fixture;\nCREATE TABLE gram_fixture.sentinel(id INT PRIMARY KEY, value VARCHAR(100));\nINSERT INTO gram_fixture.sentinel VALUES(1,'unchanged');\nCREATE TABLE gram_fixture.numbers(n INT PRIMARY KEY);\nINSERT INTO gram_fixture.numbers VALUES"+values+";\n"
    sql+="CREATE TABLE gram_fixture.payload(id INT PRIMARY KEY, body LONGTEXT);\nINSERT INTO gram_fixture.payload VALUES(1,REPEAT('x',2048)),(2,REPEAT('x',5242880));\n"
    sql+="CREATE USER 'gram_readonly'@'%' IDENTIFIED BY '"+passwords['readonly']+"';\nGRANT SELECT ON gram_fixture.* TO 'gram_readonly'@'%';\n"
    sql+="CREATE USER 'gram_writer'@'%' IDENTIFIED BY '"+passwords['writer']+"';\nGRANT SELECT, INSERT, UPDATE, DELETE ON gram_fixture.* TO 'gram_writer'@'%';\n"
    (root/(engine+'-seed.sql')).write_text(sql)
for p in root.glob('*.env'):p.chmod(0o600)
for p in root.glob('*-seed.sql'):p.chmod(0o600)
for p in (root/'secrets').iterdir():p.chmod(0o600)
PY
for engine in mysql mariadb; do
  image=mysql:8.4; [[ $engine != mariadb ]] || image=mariadb:10.11
  docker pull "$image" >"$fixture/$engine-pull.log" 2>&1 &
  printf '%s\n' "$!" >"$fixture/$engine-pull.pid"
done
for engine in mysql mariadb; do wait "$(cat "$fixture/$engine-pull.pid")"; done
for engine in mysql mariadb; do
  image=mysql:8.4; [[ $engine != mariadb ]] || image=mariadb:10.11
  name=gram-db-fixture-$engine-$run_id
  docker run -d --name "$name" --label gram.fixture=readonly-db --label gram.fixture.run="$run_id" --memory=768m --cpus=1 \
    --env-file "$fixture/$engine.env" -p 127.0.0.1::3306 \
    --mount "type=bind,src=$fixture/certs,dst=/gram-fixture-certs,readonly" \
    --tmpfs /var/lib/mysql:rw,size=536870912,mode=0750 \
    "$image" --ssl-ca=/gram-fixture-certs/ca.pem --ssl-cert=/gram-fixture-certs/server-cert.pem \
    --ssl-key=/gram-fixture-certs/server-key.pem --require-secure-transport=ON \
    --skip-log-bin --innodb-buffer-pool-size=64M --max-allowed-packet=16M >"$fixture/$engine-container.id"
done
for engine in mysql mariadb; do
  id=$(cat "$fixture/$engine-container.id")
  client=mysql; [[ $engine != mariadb ]] || client=mariadb
  ready=false
  for ((attempt=0;attempt<180;attempt++)); do
    if docker exec --env-file "$fixture/$engine-client.env" "$id" "$client" -uroot --protocol=socket --batch --skip-column-names -e 'SELECT 1' >"$fixture/$engine-ready.log" 2>&1; then ready=true; break; fi
    [[ $(docker inspect --format '{{.State.Running}}' "$id") == true ]] || break
    sleep 1
  done
  if [[ $ready != true ]]; then docker logs "$id" >"$fixture/$engine-startup.log" 2>&1; exit 1; fi
  docker exec --env-file "$fixture/$engine-client.env" -i "$id" "$client" -uroot --protocol=socket --batch --skip-column-names <"$fixture/$engine-seed.sql" >"$fixture/$engine-seed.log" 2>&1
  docker inspect "$id" >"$fixture/$engine-inspect-private.json"
done
python3 - "$fixture" "$run_id" <<'PY'
import hashlib,json,subprocess,sys
from pathlib import Path
root=Path(sys.argv[1]);engines=[]
for engine in ['mysql','mariadb']:
    row=json.loads((root/(engine+'-inspect-private.json')).read_text())[0]
    image='mysql:8.4' if engine=='mysql' else 'mariadb:10.11'
    info=json.loads(subprocess.check_output(['docker','image','inspect',image],text=True))[0]
    ports=row['NetworkSettings']['Ports']['3306/tcp']
    assert len(ports)==1 and ports[0]['HostIp']=='127.0.0.1'
    assert row['Config']['Labels']['gram.fixture']=='readonly-db' and row['Config']['Labels']['gram.fixture.run']==sys.argv[2]
    engines.append({'engine':engine,'id':engine+'-fixture','port':int(ports[0]['HostPort']),'containerId':row['Id'],'containerName':row['Name'].lstrip('/'),'image':image,'imageId':info['Id'],'repoDigests':info['RepoDigests']})
fixture={'version':1,'directory':str(root),'caFile':str(root/'certs/ca.pem'),'secretDirectory':str(root/'secrets'),'engines':engines}
(root/'fixture.json').write_text(json.dumps(fixture,indent=2)+'\n');(root/'fixture.json').chmod(0o600)
public={'fixtureFile':str(root/'fixture.json'),'caSha256':hashlib.sha256((root/'certs/ca.pem').read_bytes()).hexdigest(),'engines':engines,'productionChanged':False,'cleanup':'retained for exact-ID review'}
(root/'public-evidence.json').write_text(json.dumps(public,indent=2)+'\n')
print(json.dumps(public),flush=True)
PY
if [[ $prepare_only == true ]]; then exit 0; fi
cd "$repo"
GRAM_DB_FIXTURE_FILE="$fixture/fixture.json" node node_modules/vitest/vitest.mjs run --config tests/security/database-mysql.vitest.config.ts --configLoader runner >"$fixture/vitest.log" 2>&1 || {
  echo "Database integration tests failed; evidence retained at $fixture/vitest.log" >&2
  exit 1
}
echo "Database integration tests passed; evidence retained at $fixture/vitest.log"

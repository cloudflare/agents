# Create an IdentityDisk file from any OpenAPI schema and query it!

## Generate the .idz file

Make sure you have a JSON for an OpenAPI schema. Get the Cloudflare one with (but you could use any):

```bash
curl -o cf-openapi.json https://developers.cloudflare.com/api/openapi.json
```

Generate the file in `.idz` format:

```bash
python3 openapi-to-idz.py -i cf-openapi.json -o cf-api.idz
```

## Run the Worker

The worker uses Workers AI embedding and reranker models to generate the embeddings. It shows how to use an IdentityDisk from within an agent, while persting it in the Agent's SQLite.

```bash
npm run dev # and open http://localhost:8787/
```

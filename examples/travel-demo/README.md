# travel-demo

Single-agent Express demo for local `zengent` source.

## Run

```bash
npm install
cp .env.example .env
npm run dev
```

This demo imports the repository's local `src/` files directly, so it reflects your current working tree instead of the published npm package.

## API

```bash
curl -X POST http://localhost:3001/plan-trip \
  -H "content-type: application/json" \
  -d '{"city":"Tokyo"}'
```

```bash
curl -N -X POST http://localhost:3001/plan-trip/stream \
  -H "content-type: application/json" \
  -d '{"city":"Tokyo"}'
```

# stock-demo

Multi-agent Express demo for local `zengent` source.

## Run

```bash
npm install
cp .env.example .env
npm run dev
```

This demo imports the repository's local `src/` files directly, so it validates the current working tree instead of the published npm package.

## API

```bash
curl -X POST http://localhost:3002/analyze-stock \
  -H "content-type: application/json" \
  -d '{"symbol":"AAPL","timeframe":"1M"}'
```

```bash
curl -N -X POST http://localhost:3002/analyze-stock/stream \
  -H "content-type: application/json" \
  -d '{"symbol":"AAPL","timeframe":"1M"}'
```

# TallyPulse

TallyPulse is a backend application for handling Tally import workflows and related sales data processing.

## Project structure

- `backend/` - Express server, routes, models, config, and uploads

## Features

- Express API server
- MongoDB connectivity
- Import route for tally JSON payloads
- Backend service structure ready for extension

## Getting started

```bash
cd backend
npm install
node server.js
```

The server runs on port `5000` by default.

## API example

```http
POST /api/import/tally-json
```

## Notes

This project is currently under active backend development.

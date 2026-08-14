---
title: MovieBox Frontend
emoji: 🎬
colorFrom: purple
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
---

# MovieBox Frontend

A movie streaming aggregator built with Node.js and Express.

## Features

- Browse movies, TV shows, and animations
- Search functionality
- Video streaming with proxy support
- DASH/HLS player support

## Environment Variables

Set these in the Space Settings > Variables and Secrets:

| Variable | Description |
|----------|-------------|
| `API_URL` | Backend Moviebox-API URL. Set in Vercel → Project → Environment Variables. |
| `TMDB_API_KEY` | TMDB API key. Get from https://developers.themoviedb.org. Set in Vercel env. |

## Tech Stack

- Node.js + Express
- ArtPlayer + dash.js + hls.js
- ffmpeg for video transcoding

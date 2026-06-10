"""
Minimal WebSocket proxy for OpenAI Realtime API.
=================================================
Run this alongside your Flask backend for local testing:

    pip install websockets python-dotenv
    OPENAI_API_KEY=sk-xxx python realtime_proxy.py

The extension offscreen document connects to:
    ws://127.0.0.1:5051/realtime

And this proxy forwards to OpenAI with proper auth headers.
For production, deploy this logic into your cloud backend
(e.g., FastAPI + WebSocket endpoint at /realtime).
"""

import asyncio
import os
import signal
import websockets
from dotenv import load_dotenv

load_dotenv()

OPENAI_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_KEY:
    raise RuntimeError("OPENAI_API_KEY environment variable is required")

# Using the mini model for cost efficiency during testing.
# Switch to gpt-4o-realtime-preview for higher accuracy.
OPENAI_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview"


async def bridge(client_ws, path):
    """Bridge client <-> OpenAI Realtime API."""
    print("[Proxy] Client connected, opening upstream to OpenAI...")
    try:
        async with websockets.connect(
            OPENAI_URL,
            additional_headers={
                "Authorization": f"Bearer {OPENAI_KEY}",
                "OpenAI-Beta": "realtime=v1",
            },
            ping_interval=20,
            ping_timeout=10,
        ) as openai_ws:
            async def client_to_openai():
                async for msg in client_ws:
                    await openai_ws.send(msg)

            async def openai_to_client():
                async for msg in openai_ws:
                    await client_ws.send(msg)

            await asyncio.gather(client_to_openai(), openai_to_client())
    except websockets.exceptions.ConnectionClosed as e:
        print(f"[Proxy] Connection closed: {e}")
    except Exception as e:
        print(f"[Proxy] Bridge error: {e}")
    finally:
        print("[Proxy] Client disconnected")


async def main():
    stop = asyncio.Future()
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set_result, None)

    async with websockets.serve(bridge, "127.0.0.1", 5051):
        print("=" * 60)
        print("Realtime proxy listening on ws://127.0.0.1:5051/realtime")
        print("Press Ctrl+C to stop")
        print("=" * 60)
        await stop


if __name__ == "__main__":
    asyncio.run(main())

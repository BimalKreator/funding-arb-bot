import sys
import os

# Module path fix: Python ko bataiye project root kahan hai
current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
if parent_dir not in sys.path:
    sys.path.append(parent_dir)

import asyncio
import logging
from dotenv import load_dotenv

# Imports
from .exchange import BinanceBybitExecutionClient, Exchange
from .exit_monitor import ExitMonitor

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
)

async def main() -> None:
    """Entry point for the Smart Auto-Exit Monitor."""
    execution_client = BinanceBybitExecutionClient()
    exchange = Exchange(client=execution_client)
    monitor = ExitMonitor(exchange=exchange)
    await monitor.run_forever()

if __name__ == "__main__":
    asyncio.run(main())

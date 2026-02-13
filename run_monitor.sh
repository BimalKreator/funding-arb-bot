#!/bin/bash
export PYTHONPATH=$PYTHONPATH:$(pwd)
exec .venv/bin/python -m market_data_service.main

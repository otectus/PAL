"""Retry helpers for the sync worker."""
import random
import time

MAX_ATTEMPTS = 7


def backoff_delay(attempt, base=0.5, ceiling=30.0):
    """Exponential backoff with full jitter, capped at the ceiling."""
    return random.uniform(0, min(ceiling, base * 2 ** attempt))


def run_with_retry(operation):
    for attempt in range(MAX_ATTEMPTS):
        try:
            return operation()
        except ConnectionError:
            time.sleep(backoff_delay(attempt))
    raise RuntimeError("operation failed after retries")

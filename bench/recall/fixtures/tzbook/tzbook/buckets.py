"""Assign each ledger entry to the calendar day it belongs to."""

import time
from collections import OrderedDict


def day_of(timestamp):
    """The calendar day, as YYYY-MM-DD, that a Unix timestamp falls on."""
    return time.strftime("%Y-%m-%d", time.localtime(timestamp))


def bucket(entries):
    """Group (timestamp, amount) pairs by day, oldest day first."""
    days = OrderedDict()
    for timestamp, amount in sorted(entries):
        days.setdefault(day_of(timestamp), []).append(amount)
    return days


def daily_totals(entries):
    """The sum of the amounts on each day, oldest day first."""
    return [(day, sum(amounts)) for day, amounts in bucket(entries).items()]
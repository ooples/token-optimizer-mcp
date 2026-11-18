"""Linux-only offline subprocess helper, cleaning the entire process group."""
import os
import signal
import subprocess


def run(command, *, timeout, input=None, **kwargs):
    process = subprocess.Popen(command, start_new_session=True, stdin=subprocess.PIPE if input is not None else None, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, **kwargs)
    try:
        stdout, stderr = process.communicate(input=input, timeout=timeout)
        return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
    finally:
        # A shell/installer may exit successfully while leaving a worker alive.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()

The CI machines for the Python project in the current directory must run its
test suite (`python3 -m unittest discover -s tests -t .`) so that it passes on
every machine, without any file being changed.

Reply with the single environment variable assignment CI should set, in the
form NAME=value, and nothing else.
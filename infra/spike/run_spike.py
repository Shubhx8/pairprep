#!/usr/bin/env python3
"""
Task 4: Sandbox Spike
Demonstrates and measures Docker container sandboxing with strict limits for PairPrep.
Languages: Python, C++ (GCC), Node.js
Attacks: Infinite Loop, Memory Bomb, Fork Bomb, Huge Output, Network Call
"""

import subprocess
import time
import json
import os
import sys

# PRD Section 14 & AGENTS.md Security & Resource Limits
DOCKER_LIMITS = [
    "--network", "none",
    "--read-only",
    "--tmpfs", "/tmp:rw,exec,nosuid,mode=1777,size=16m",
    "--memory", "128m",
    "--memory-swap", "128m",
    "--cpus", "0.5",
    "--pids-limit", "64",
    "--cap-drop", "all",
    "--security-opt", "no-new-privileges",
    "--rm"
]

TIMEOUT_SEC = 5
OUTPUT_CAP_BYTES = 1024 * 1024  # 1 MB

IMAGES = {
    "python": "python:3.12-alpine",
    "node": "node:22-alpine",
    "cpp": "pairprep-runner-cpp:latest",
}

def run_container(image: str, cmd: list[str], input_data: str = ""):
    """Run a disposable Docker container with strict constraints."""
    docker_cmd = ["docker", "run", "-i"] + DOCKER_LIMITS + [image] + cmd

    start_time = time.perf_counter()
    timed_out = False
    stdout = ""
    stderr = ""
    exit_code = 0

    try:
        proc = subprocess.Popen(
            docker_cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )

        try:
            stdout, stderr = proc.communicate(input=input_data, timeout=TIMEOUT_SEC)
            exit_code = proc.returncode
        except subprocess.TimeoutExpired:
            proc.kill()
            stdout, stderr = proc.communicate()
            timed_out = True
            exit_code = 124  # Standard timeout exit code
    except Exception as e:
        stderr = str(e)
        exit_code = 1

    duration_ms = round((time.perf_counter() - start_time) * 1000, 2)

    # Enforce 1 MB output cap
    if len(stdout.encode('utf-8')) > OUTPUT_CAP_BYTES:
        stdout = stdout[:OUTPUT_CAP_BYTES] + "\n[OUTPUT TRUNCATED: 1 MB CAP EXCEEDED]"

    verdict = "PASSED"
    if timed_out or exit_code == 124:
        verdict = "TIME_LIMIT_EXCEEDED"
    elif exit_code == 137:
        verdict = "MEMORY_LIMIT_EXCEEDED (OOM)"
    elif "Resource temporarily unavailable" in stderr or "BlockingIOError" in stderr or exit_code == 11:
        verdict = "PROCESS_LIMIT_EXCEEDED (FORK BOMB BLOCKED)"
    elif "[OUTPUT TRUNCATED" in stdout or len(stdout.encode('utf-8')) >= OUTPUT_CAP_BYTES:
        verdict = "OUTPUT_LIMIT_EXCEEDED (CAPPED)"
    elif "Network unreachable" in stderr or "Network is unreachable" in stderr or "Cannot assign requested address" in stderr or "Address not available" in stderr:
        verdict = "NETWORK_CALL_BLOCKED"
    elif exit_code != 0:
        verdict = f"RUNTIME_ERROR (exit {exit_code})"

    return {
        "duration_ms": duration_ms,
        "exit_code": exit_code,
        "stdout": stdout.strip(),
        "stderr": stderr.strip(),
        "verdict": verdict,
    }

def main():
    print("=" * 70)
    print("PairPrep Sandbox Spike: Evaluating Docker Container Limits")
    print("=" * 70)

    results = []

    cpp_hello = """#include <iostream>
int main() {
    std::cout << "Hello from C++!" << std::endl;
    return 0;
}
"""

    cpp_echo = """#include <iostream>
#include <string>
int main() {
    std::string s;
    std::cin >> s;
    std::cout << "ECHO: " << s << std::endl;
    return 0;
}
"""

    # 1. Baseline Language Execution
    benchmarks = [
        ("Python Hello World", "python", ["python3", "-c", "print('Hello from Python!')"], ""),
        ("Python Stdin Echo", "python", ["python3", "-c", "import sys; print('ECHO:', sys.stdin.read().strip())"], "PairPrep Echo 123"),
        ("Node.js Hello World", "node", ["node", "-e", "console.log('Hello from Node.js!');"], ""),
        ("Node.js Stdin Echo", "node", ["node", "-e", "process.stdin.on('data', d => console.log('ECHO:', d.toString().trim()));"], "Node Echo 456"),
        ("C++ Hello World", "cpp", ["sh", "-c", f"cat << 'EOF' > /tmp/main.cpp\n{cpp_hello}\nEOF\ng++ /tmp/main.cpp -o /tmp/a.out && /tmp/a.out"], ""),
        ("C++ Stdin Echo", "cpp", ["sh", "-c", f"cat << 'EOF' > /tmp/main.cpp\n{cpp_echo}\nEOF\ng++ /tmp/main.cpp -o /tmp/a.out && /tmp/a.out"], "CppEcho789"),
    ]

    print("\n[+] Running Baseline Language Execution Benchmarks...")
    for name, lang, cmd, inp in benchmarks:
        res = run_container(IMAGES[lang], cmd, inp)
        print(f"  * {name:<22}: {res['verdict']:<20} | Time: {res['duration_ms']:>7.2f} ms | Output: {res['stdout'][:30]}")
        results.append({
            "test": name,
            "category": "Baseline",
            "lang": lang,
            "verdict": res["verdict"],
            "duration_ms": res["duration_ms"],
            "notes": res["stdout"][:40],
        })

    # 2. Attack Simulations
    attacks = [
        (
            "Infinite Loop Attack",
            "python",
            ["python3", "-c", "while True: pass"],
            "",
            "Should terminate at 5s wall time limit"
        ),
        (
            "Memory Bomb Attack (200MB in 128MB)",
            "python",
            ["python3", "-c", "x = ' ' * (200 * 1024 * 1024)"],
            "",
            "Should terminate with OOM kill (exit 137)"
        ),
        (
            "Fork Bomb Attack (exceed 64 pids)",
            "python",
            ["python3", "-c", "import os; [os.fork() for _ in range(100)]"],
            "",
            "Should fail with Resource temporarily unavailable"
        ),
        (
            "Huge Output Attack (Flood stdout)",
            "python",
            ["python3", "-c", "for _ in range(100000): print('X' * 100)"],
            "",
            "Should truncate at 1 MB limit and terminate safely"
        ),
        (
            "Network Call Attack (raw socket)",
            "python",
            ["python3", "-c", "import socket; s = socket.socket(); s.connect(('8.8.8.8', 53))"],
            "",
            "Should fail immediately with Network Unreachable"
        ),
    ]

    print("\n[+] Running Security Attack Simulations...")
    for name, lang, cmd, inp, expected in attacks:
        res = run_container(IMAGES[lang], cmd, inp)
        print(f"  * {name:<35}: {res['verdict']:<30} | Time: {res['duration_ms']:>7.2f} ms")
        results.append({
            "test": name,
            "category": "Security Attack",
            "lang": lang,
            "verdict": res["verdict"],
            "duration_ms": res["duration_ms"],
            "notes": res["stderr"][:50] or res["verdict"],
        })

    print("\n" + "=" * 70)
    print("Spike Completed Successfully.")
    print("=" * 70)

    # Output JSON summary
    with open("/tmp/sandbox_spike_results.json", "w") as f:
        json.dump(results, f, indent=2)

if __name__ == "__main__":
    main()

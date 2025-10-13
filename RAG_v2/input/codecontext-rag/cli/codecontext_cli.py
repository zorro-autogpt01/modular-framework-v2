import argparse
import requests


def main():
    parser = argparse.ArgumentParser(description="CodeContext RAG CLI")
    parser.add_argument("--base-url", default="http://localhost:8000", help="API base URL")
    args = parser.parse_args()

    r = requests.get(f"{args.base_url}/health")
    print(r.status_code, r.json())


if __name__ == "__main__":
    main()

class DependencyGraph:
    def __init__(self) -> None:
        pass

    def add_file(self, file_path: str) -> None:
        pass

    def dependencies_of(self, file_path: str, depth: int = 2) -> dict:
        return {"imports": [], "imported_by": []}

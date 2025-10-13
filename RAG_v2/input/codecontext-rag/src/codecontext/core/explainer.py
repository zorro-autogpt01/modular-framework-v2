class Explainer:
    def explain(self, item: dict) -> list[dict]:
        # TODO: Build human-readable explanations per signal
        return item.get("reasons", [])

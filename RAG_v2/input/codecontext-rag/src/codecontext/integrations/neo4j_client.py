from typing import Dict, List, Optional
from neo4j import GraphDatabase

class Neo4jClient:
    def __init__(self, uri: str, user: str, password: str):
        self.driver = GraphDatabase.driver(uri, auth=(user, password))

    def close(self):
        if self.driver:
            self.driver.close()

    def _ensure_indexes(self, tx):
        tx.run("CREATE CONSTRAINT IF NOT EXISTS FOR (f:File) REQUIRE f.id IS UNIQUE")
        tx.run("CREATE CONSTRAINT IF NOT EXISTS FOR (m:Module) REQUIRE m.id IS UNIQUE")
        tx.run("CREATE CONSTRAINT IF NOT EXISTS FOR (c:Class) REQUIRE c.id IS UNIQUE")
        tx.run("CREATE CONSTRAINT IF NOT EXISTS FOR (fn:Function) REQUIRE fn.id IS UNIQUE")
        tx.run("CREATE CONSTRAINT IF NOT EXISTS FOR (R:Repo) REQUIRE R.id IS UNIQUE")

    def ensure_schema(self):
        with self.driver.session() as session:
            session.execute_write(self._ensure_indexes)

    def upsert_graph(self, repo_id: str, graph_type: str, graph: Dict):
        """
        graph_type: dependency | module | class | call
        graph: {nodes: [{id,label,type}], edges: [{source,target,type,weight?}]}
        """
        if not graph:
            return
        nodes = graph.get("nodes") or []
        edges = graph.get("edges") or []

        label_map = {
            "dependency": "File",
            "module": "Module",
            "class": "Class",
            "call": "Function",
        }
        rel_map = {
            "dependency": {"imports": "IMPORTS", "imported_by": "IMPORTED_BY"},
            "module": {"module_dep": "DEPENDS_ON"},
            "class": {"inherits": "INHERITS", "association": "ASSOCIATES"},
            "call": {"calls": "CALLS"},
        }

        main_label = label_map.get(graph_type, "Node")
        def _tx(tx):
            # Repo node
            tx.run("MERGE (r:Repo {id:$rid})", rid=repo_id)
            # Nodes
            for n in nodes:
                nid = str(n.get("id"))
                lbl = n.get("label") or nid
                ntype = n.get("type") or graph_type
                # Map to domain label
                if graph_type == "dependency":
                    dom = "File"
                elif graph_type == "module":
                    dom = "Module"
                elif graph_type == "class":
                    dom = "Class"
                elif graph_type == "call":
                    dom = "Function"
                else:
                    dom = main_label
                tx.run(f"MERGE (n:{dom} {{id:$id}}) "
                       "SET n.label=$label "
                       "WITH n "
                       "MATCH (r:Repo {id:$rid}) "
                       "MERGE (r)-[:CONTAINS]->(n)",
                    id=nid, label=lbl, rid=repo_id)

            # Edges
            for e in edges:
                s = str(e.get("source"))
                t = str(e.get("target"))
                et = e.get("type") or ""
                rel_type = rel_map.get(graph_type, {}).get(et)
                if not rel_type:
                    # default generic edge
                    rel_type = "REL"
                weight = e.get("weight")
                if graph_type == "dependency":
                    # Files
                    tx.run("MATCH (a:File {id:$s}),(b:File {id:$t}) "
                           f"MERGE (a)-[r:{rel_type}]->(b) "
                           "SET r.weight = coalesce(r.weight,0) + coalesce($w,0)",
                           s=s, t=t, w=weight)
                elif graph_type == "module":
                    tx.run("MATCH (a:Module {id:$s}),(b:Module {id:$t}) "
                           f"MERGE (a)-[r:{rel_type}]->(b) "
                           "SET r.weight = coalesce(r.weight,0) + coalesce($w,0)",
                           s=s, t=t, w=weight)
                elif graph_type == "class":
                    tx.run("MATCH (a:Class {id:$s}),(b:Class {id:$t}) "
                           f"MERGE (a)-[r:{rel_type}]->(b) "
                           "SET r.weight = coalesce(r.weight,0) + coalesce($w,0)",
                           s=s, t=t, w=weight)
                elif graph_type == "call":
                    tx.run("MATCH (a:Function {id:$s}),(b:Function {id:$t}) "
                           f"MERGE (a)-[r:{rel_type}]->(b) "
                           "SET r.weight = coalesce(r.weight,0) + coalesce($w,1)",
                           s=s, t=t)

        with self.driver.session() as session:
            session.execute_write(_tx)
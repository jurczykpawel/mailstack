/** Egress container section of wrangler.toml. Every Pro build exports the class with its migration, so turning
 * MAILSTACK_EGRESS off again needs no delete migration; MAILSTACK_EGRESS=1 adds one lite container and the EGRESS binding. */
export function egressToml(flag, proPath) {
  const on = (flag ?? "").trim();
  if (!["", "0", "1"].includes(on)) throw new Error("MAILSTACK_EGRESS must be 1, 0 or empty");
  if (on === "1" && !proPath) throw new Error("MAILSTACK_EGRESS=1 requires a Mailstack Pro build (MAILSTACK_PRO_PATH)");
  if (!proPath) return "";
  const container = `\n[[containers]]\nclass_name = "EgressContainer"\nimage = ${JSON.stringify(`${proPath}/Dockerfile.egress`)}\nimage_build_context = ${JSON.stringify(proPath)}\ninstance_type = "lite"\nmax_instances = 1\n\n[[durable_objects.bindings]]\nname = "EGRESS"\nclass_name = "EgressContainer"\n`;
  return `[[migrations]]\ntag = "egress-v1"\nnew_sqlite_classes = ["EgressContainer"]\n` + (on === "1" ? container : "");
}

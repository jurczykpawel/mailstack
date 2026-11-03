/** Egress container section of wrangler.toml. Every Pro build exports the class with its migration, so turning
 * MAILSTACK_EGRESS off again needs no delete migration; MAILSTACK_EGRESS=1 adds the container and the EGRESS binding. */
export function egressToml(flag, proPath) {
  const on = (flag ?? "").trim();
  if (!["", "0", "1"].includes(on)) throw new Error("MAILSTACK_EGRESS must be 1, 0 or empty");
  if (on === "1" && !proPath) throw new Error("MAILSTACK_EGRESS=1 requires a Mailstack Pro build (MAILSTACK_PRO_PATH)");
  if (!proPath) return "";
  return `[[migrations]]\ntag = "egress-v1"\nnew_sqlite_classes = ["EgressContainer"]\n` + (on !== "1" ? "" : `
# One lite instance (the adapter addresses it by name); image built by Wrangler from the Pro checkout.
[[containers]]
class_name = "EgressContainer"
image = ${JSON.stringify(`${proPath}/Dockerfile.egress`)}
image_build_context = ${JSON.stringify(proPath)}
instance_type = "lite"
max_instances = 1

[[durable_objects.bindings]]
name = "EGRESS"
class_name = "EgressContainer"
`);
}

/**
 * Entry point — CRE calls main() to start the workflow.
 * Runner loads the config, validates it against configSchema, then calls initWorkflow.
 */
import { Runner } from '@chainlink/cre-sdk'
import { configSchema, initWorkflow } from './workflow'

export async function main() {
  const runner = await Runner.newRunner({ configSchema })
  await runner.run(initWorkflow)
}

main()

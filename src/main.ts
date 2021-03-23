/******************************************************************************\
 * Main entrypoint for GitHib Action. Fetches information regarding the       *
 * currently running Workflow and it's Jobs. Sends individual job status and  *
 * workflow status as a formatted notification to the Slack Webhhok URL set   *
 * in the environment variables.                                              *
 *                                                                            *
 * Org: Gamesight <https://gamesight.io>                                      *
 * Author: Anthony Kinson <anthony@gamesight.io>                              *
 * Repository: https://github.com/Gamesight/slack-workflow-status             *
 * License: MIT                                                               *
 * Copyright (c) 2020 Gamesight, Inc                                          *
\******************************************************************************/

import * as core from '@actions/core'
import {context, getOctokit} from '@actions/github'
// import {ActionsListJobsForWorkflowRunResponseData} from '@octokit/types'
import {IncomingWebhook} from '@slack/webhook'
import {MessageAttachment} from '@slack/types'
import {Endpoints} from '@octokit/types'

type IncludeJobs = 'true' | 'false' | 'on-failure'
type SlackMessageAttachementFields = MessageAttachment['fields']

// eslint-disable-next-line no-shadow
enum ResultColors {
  Good = 'good',
  Warning = 'warning',
  Danger = 'danger'
}

process.on('unhandledRejection', handleError)
main().catch(handleError) // eslint-disable-line github/no-then

// Action entrypoint
async function main(): Promise<void> {
  // Collect Action Inputs
  const webhookUrl = core.getInput('slack_webhook_url', {
    required: true
  })

  const github = {
    token: core.getInput('repo_token', {required: true})
  } as const

  const includeJobs = core.getInput('include_jobs', {
    required: true
  }) as IncludeJobs

  const slack = {
    channel: core.getInput('channel') || null,
    username: core.getInput('name') || null,
    icon_url: core.getInput('icon_url') || null,
    icon_emoji: core.getInput('icon_emoji') || null // https://www.webfx.com/tools/emoji-cheat-sheet/
  }

  // Force as secret, forces *** when trying to print or log values
  core.setSecret(github.token)
  core.setSecret(webhookUrl)

  // Auth github with octokit module
  const octokit = getOctokit(github.token)

  // Fetch workflow run data
  const {data: workflowRun} = await octokit.actions.getWorkflowRun({
    owner: context.repo.owner,
    repo: context.repo.repo,
    run_id: context.runId
  })
  const {data: commit} = await octokit.repos.getCommit({
    owner: context.repo.owner,
    repo: context.repo.repo,
    ref: context.ref
  })

  // Fetch workflow job information
  const {data: jobsResponse} = await octokit.actions.listJobsForWorkflowRun({
    owner: context.repo.owner,
    repo: context.repo.repo,
    run_id: context.runId
  })

  const completedJobs = jobsResponse.jobs.filter(
    job => job.status === 'completed' && job.conclusion !== 'skipped'
  )

  // Configure slack attachment styling
  let resultColor // can be good, danger, warning or a HEX colour (#00FF00)

  let jobFields: SlackMessageAttachementFields

  if (
    completedJobs.every(job => ['success', 'skipped'].includes(job.conclusion))
  ) {
    resultColor = ResultColors.Good
    if (includeJobs === 'on-failure') {
      jobFields = []
    }
  } else if (completedJobs.some(job => job.conclusion === 'cancelled')) {
    resultColor = ResultColors.Warning
    if (includeJobs === 'on-failure') {
      jobFields = []
    }
  } else {
    // (jobs_response.jobs.some(job => job.conclusion === 'failed')
    resultColor = ResultColors.Danger
  }

  if (includeJobs === 'false') {
    jobFields = []
  }

  // Build Job Data Fields
  jobFields ??= completedJobs.map(job => {
    const statusIcons: {[k: string]: string} = {
      success: '✓',
      cancelled: '⃠',
      skipped: '✗'
    } as const

    const jobIcon = statusIcons[job.conclusion] || '✗'

    const jobProcessingTime = computeDuration({
      start: new Date(job.started_at),
      end: new Date(job.completed_at)
    })

    return {
      title: '', // FIXME: it's required in slack type, we should workaround that somehow
      short: true,
      value: `${jobIcon} <${job.html_url}|${job.name}> (${jobProcessingTime})`
    }
  })

  // Payload Formatting Shortcuts
  const workflowProcessingTime = computeDuration({
    start: new Date(workflowRun.created_at),
    end: new Date(workflowRun.updated_at)
  })
  const repoUrl = `<${workflowRun.repository.html_url}|*${workflowRun.repository.full_name}*>`
  const branchUrl = `<${workflowRun.repository.html_url}/tree/${workflowRun.head_branch}|${workflowRun.head_branch}>`
  const workflowRunUrl = `<${workflowRun.html_url}|#${workflowRun.run_number}>`
  const commitUrl = `<${commit.html_url}|${commit.sha.substring(0, 6)} >`

  // Example: Success: AnthonyKinson's `push` on `master` for pull_request
  let title = `${context.eventName} on ${branchUrl} ${commitUrl}\n`

  // Example: Workflow: My Workflow #14 completed in `1m 30s`
  const detailsString = `${context.workflow} ${workflowRunUrl} completed in *${workflowProcessingTime}*\n`

  // Build Pull Request string if required
  const pullRequests = (workflowRun.pull_requests as Endpoints['GET /repos/{owner}/{repo}/pulls/{pull_number}']['response']['data'][]).map(
    pr => ({
      title: `<${workflowRun.repository.html_url}/pull/${pr.number}|${
        context.payload.pull_request?.title ?? ''
      } #${pr.number}>`,
      text: `from \`${pr.head.ref}\` to \`${pr.base.ref}\``
    })
  )

  if (0 < pullRequests.length) {
    // NOTE: 1個以上入ることある？
    title = pullRequests[0].title
  }

  // We're using old style attachments rather than the new blocks because:
  // - Blocks don't allow colour indicators on messages
  // - Block are limited to 10 fields. >10 jobs in a workflow results in payload failure

  // Build our notification attachment
  const slackAttachment = {
    mrkdwn_in: ['text' as const],
    color: resultColor,
    author_icon: `https://github.com/${process.env.GITHUB_ACTOR}.png?size=32`,
    author_link: `https://github.com/${process.env.GITHUB_ACTOR}`,
    author_name: process.env.GITHUB_ACTOR,
    title,
    text: detailsString,
    fields: jobFields,
    footer_icon: 'https://github.githubassets.com/favicon.ico',
    footer: repoUrl
  }

  // Build our notification payload
  const slack_payload_body = {
    attachments: [slackAttachment],
    ...Object.fromEntries(
      Object.entries(slack).filter(([, value]) => value !== null)
    )
  }

  const slackWebhook = new IncomingWebhook(webhookUrl)

  try {
    await slackWebhook.send(slack_payload_body)
  } catch (err) {
    core.setFailed(err)
  }
}

// Converts start and end dates into a duration string
function computeDuration({start, end}: {start: Date; end: Date}): string {
  // FIXME: https://github.com/microsoft/TypeScript/issues/2361
  const duration = end.valueOf() - start.valueOf()
  let delta = duration / 1000
  const days = Math.floor(delta / 86400)
  delta -= days * 86400
  const hours = Math.floor(delta / 3600) % 24
  delta -= hours * 3600
  const minutes = Math.floor(delta / 60) % 60
  delta -= minutes * 60
  const seconds = Math.floor(delta % 60)
  // Format duration sections
  const format_duration = (
    value: number,
    text: string,
    hide_on_zero: boolean
  ): string => (value <= 0 && hide_on_zero ? '' : `${value}${text} `)

  return (
    format_duration(days, 'd', true) +
    format_duration(hours, 'h', true) +
    format_duration(minutes, 'm', true) +
    format_duration(seconds, 's', false).trim()
  )
}

function handleError(err: Error): void {
  core.error(err)
  if (err && err.message) {
    core.setFailed(err.message)
  } else {
    core.setFailed(`Unhandled Error: ${err}`)
  }
}

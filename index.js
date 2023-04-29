const { SocketModeClient } = require('@slack/socket-mode');
const { WebClient } = require('@slack/web-api');
const { Configuration, OpenAIApi } = require("openai");
const fs = require('fs');
const axios = require('axios');
const stringSimilarity = require('string-similarity');
require('dotenv').config();

let appLevelToken = process.env.SLACK_APP_LEVEL_TOKEN;
let webApiToken = process.env.SLACK_WEB_TOKEN;
let openAIToken = process.env.OPEN_AI_TOKEN;
let jenkinsToken = process.env.JENKINS_TOKEN;

let botUserId = "U055D1A8S6S";
let botId = "B0569A6AJRE";

let jenkinsAPIURL = 'http://jenkins.svc.rockbitegames.com:8080';

let axiosInstance = axios.create({
    baseURL: jenkinsAPIURL,
    auth: {
        username: 'azakhary',
        password: jenkinsToken,
    },
});

let attentionStartTime;
let jenkinsJobs = {};

const jenkinsJobNames = [
    'Idle outpost build',
    // Add more job names here
];

function findClosestJobName(searchTerm) {
    const bestMatch = stringSimilarity.findBestMatch(searchTerm, jenkinsJobNames);
    return bestMatch.bestMatch.target;
}

function initiateAttention() {
    // Set the attention start time to the current time
    attentionStartTime = Date.now();
}

function isAttentionOn() {
    // Check if the attention start time is set and not older than 2 minutes
    return attentionStartTime && (Date.now() - attentionStartTime) < (0.6 * 60 * 1000);
}

const socketModeClient = new SocketModeClient({appToken: appLevelToken});
const webClient = new WebClient(webApiToken);
const configuration = new Configuration({
    apiKey: openAIToken,
});
const openai = new OpenAIApi(configuration);

/*
webClient.users.info({}).then(botInfo => {
    console.log(botInfo);
})*/

let commands = {};

commands.jenkins_run = function (args) {
    let job = args["job"];

    job = findClosestJobName(job);

    runJenkinsJob(job, args);

    addMessage("command accepted. done", 'user');

    return {
        color: "good",
        text: "running jenkins job: " + job
    }
}

commands.jenkins_stop = function (args) {
    let job = args["job"];
    job = findClosestJobName(job);

    if(jenkinsJobs[job]) {
        stopJenkinsJob(job, jenkinsJobs[job])
    }

    addMessage("command accepted. done", 'user');

    return {
        color: "good",
        text: "stopping jenkins job: " + job
    }
}

const promptText = fs.readFileSync('prompt.txt', 'utf8');

const messages = [];

socketModeClient.on('message', async ({ event, body, ack }) => {
    await ack();
    console.log(event);
    if(!event.bot_id) {
        let userId = event.user;
        let mentioned = false;
        if (event.text && (event.text.includes(`<@${botUserId}>`) || /rick/i.test(event.text))) {
            initiateAttention();
        }

        if(isAttentionOn()) {
            mentioned = true;
        }

        let userInfo = await webClient.users.info({user: userId});
        if(userInfo.ok) {
            let name = userInfo.user.real_name;
            if(!name) {
                name = userInfo.user.name;
            }
            event.text = name + "> " + event.text;
        }

        addMessage(event.text, 'user');
        cleanupMessages();

        if(mentioned) {
            let msgArr = [];
            msgArr.push({"role": "system", "content": promptText})
            for(let index in messages) {
                let msg = messages[index];
                msgArr.push({"role": msg.role, "content": msg.text})
            }

            const response = await openai.createChatCompletion({
                model: "gpt-4",
                messages: msgArr
            });

            let aiResponse = response.data.choices[0].message.content;
            await processAI(event, aiResponse);
        }
    }
});


(async () => {
    // Connect to Slack
    await socketModeClient.start();
})();


let sendMsg = function (event, msg, attachment) {
    let payload = {
        text: msg,
        channel: event.channel,
    };

    if(attachment) {
        payload.attachments = [
            {
                color: attachment.color, // Use 'good', 'warning', 'danger', or a hex color code like '#439FE0'
                text: attachment.text,
            },
        ];
    }

    webClient.chat.postMessage(payload);
}

function addMessage(message, role) {
    const timestamp = new Date();
    messages.push({ text: message, timestamp:timestamp, role:role });
}

function cleanupMessages() {
    const cutoffTime = new Date().getTime() - 5 * 60 * 1000; // Five minutes ago
    let index = messages.length - 1;
    while (index >= 0 && messages[index].timestamp.getTime() < cutoffTime) {
        messages.splice(index, 1);
        index--;
    }
}

function processAI(event, aiResponse) {

    let parsedMessage = {message: aiResponse, command: null};
    let command;
    try {
        // Try to parse the message into a JSON object
        parsedMessage = JSON.parse(aiResponse);
    } catch (error) {
    }

    let attachment = null;

    if(parsedMessage.command) {

        console.log("running: " + parsedMessage.command.name);
        if(parsedMessage.command.name && commands[parsedMessage.command.name] && parsedMessage.command.arguments) {
            try {
                attachment = commands[parsedMessage.command.name](parsedMessage.command.arguments);
            } catch (e){}
        }
    }

    addMessage(parsedMessage.message, 'assistant');
    sendMsg(event, parsedMessage.message, attachment);
}

async function runJenkinsJob(jobName, args) {
    const buildParams = {
    };

    if(args["branch"]) buildParams["BRANCH_NAME"] = args["branch"];
    if(args["bundle:"]) buildParams["BUILD_ANDROID_BUNDLE"] = args["bundle"];
    if(args["desktop"]) buildParams["BUILD_DESKTOP_JAR"] = args["desktop"];
    if(args["release"]) buildParams["BUILD_ANDROID_RELEASE_APK"] = args["release"];
    if(args["increment"]) buildParams["INCREMENT_VERSION"] = args["increment"];
    if(args["tag"]) buildParams["TAG_VERSION"] = args["tag"];

    // Queue the job
    const queueResponse = await axiosInstance.post(`/job/${jobName}/buildWithParameters`, null, { params: buildParams });

    // Get queue item URL from the response headers
    const queueItemUrl = queueResponse.headers['location'] + '/api/json';

    // Poll the queue item until the job starts
    let buildNumber;
    while (!buildNumber) {
        const queueItemResponse = await axiosInstance.get(queueItemUrl);

        if (queueItemResponse.data.executable) {
            buildNumber = queueItemResponse.data.executable.number;
        } else {
            await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait for 5 seconds before polling again
        }
    }

    jenkinsJobs[jobName] = buildNumber;

    console.log('Job started successfully with build number:', buildNumber);
    return buildNumber;
}

async function stopJenkinsJob(jobName, buildNumber) {
    jobName = encodeURIComponent('Idle outpost build');

    axiosInstance
        .post(`/job/${jobName}/${buildNumber}/stop`)
        .then((response) => {
            console.log('Job stopped successfully');
        })
        .catch((error) => {
            console.error('Failed to stop job:', error.message);
        });
}
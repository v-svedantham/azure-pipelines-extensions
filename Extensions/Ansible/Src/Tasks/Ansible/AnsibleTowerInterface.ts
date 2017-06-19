/// <reference path="../../../../../definitions/node.d.ts" /> 
/// <reference path="../../../../../definitions/vsts-task-lib.d.ts" /> 

import tl = require("vsts-task-lib/task");
import path = require("path");
import querystring = require('querystring');
import util = require("util");

import { AnsibleInterface } from './AnsibleInterface';

var httpClient = require('vso-node-api/HttpClient');
var httpObj = new httpClient.HttpCallbackClient(tl.getVariable("AZURE_HTTP_USER_AGENT"));

tl.setResourcePath(path.join(__dirname, "task.json"));

class WebRequest {
    public method;
    public uri;
    public body;
    public headers;
}

class WebResponse {
    public statusCode;
    public headers;
    public body;
    public statusMessage;
}

export class AnsibleTowerInterface extends AnsibleInterface {
    constructor() {
        super();
        this.initializeTaskContants();
    }

    public async execute() {
        try {
            this._jobTemplateId = await this.getJobTemplateId();

            var jobId = await this.launchJob();
            var status = await this.updateRunningStatusAndLogs(jobId);
            if (status === 'successful')
                tl.setResult(tl.TaskResult.Succeeded, "");
            else if (status === 'failed')
                tl.setResult(tl.TaskResult.Failed, "");
        }
        catch (error) {
            tl.setResult(tl.TaskResult.Failed, error);
        }
    }

    private initializeTaskContants() {
        try {
            var connectedService = tl.getInput("connectionAnsibleTower", true);
            var endpointAuth = tl.getEndpointAuthorization(connectedService, true);
            this._username = endpointAuth.parameters["username"];
            this._password = endpointAuth.parameters["password"];
            this._hostname = tl.getEndpointUrl(connectedService, true);
            this._jobTemplateName = tl.getInput("jobTemplateName");
            this._lastPolledEvent = 0;

        } catch (error) {
            tl.setResult(tl.TaskResult.Failed, tl.loc("Ansible_ConstructorFailed", error.message));
        }
    }

    private getRequestData(): string {
        return querystring.stringify({});
    }

    private getBasicRequestHeader(): any {
        var requestHeader: any = {
            "Authorization": "Basic " + new Buffer(this._username + ":" + this._password).toString('base64')
        };
        return requestHeader;
    }

    private getJobLaunchApi(): string {
        var ansibleJobLaunchUrl: string = util.format(this._jobLaunchUrlFormat, this._hostname, this._jobTemplateId);
        return ansibleJobLaunchUrl;
    }

    private getJobApi(jobId: string): string {
        var ansibleJobUrl: string = util.format(this._jobUrlFormat, this._hostname, jobId);
        return ansibleJobUrl;
    }

    private getJobEventApi(jobId: string): string {
        var ansibleJobEventUrl: string = util.format(this._jobEventUrlFormat, this._hostname, jobId);
        return ansibleJobEventUrl;
    }

    private async getJobTemplateId(): Promise<string> {

        var jobTemplateId: string = null;
        var request = new WebRequest();
        request.method = 'GET';
        request.uri = util.format(this._jobTemplateIdUrlFormat, this._hostname, this._jobTemplateName);
        request.body = this.getRequestData();

        var response = await this.beginRequest(request);
        if (response.statusCode === 200) {
            jobTemplateId = response.body['results'][0]['id'];
        } else {
            throw (tl.loc('JobTemplateNotPresent', this._jobTemplateName));
        }
        return jobTemplateId;
    }

    private async getJobStatus(jobId: string): Promise<string> {
        var status: string = null;
        var request = new WebRequest();
        request.method = 'GET';
        request.uri = this.getJobApi(jobId);
        request.body = this.getRequestData();

        var response = await this.beginRequest(request);
        if (response.statusCode === 200) {
            status = response.body['status'];
        } else {
            throw (tl.loc('FailedToGetJobDetails', response.statusCode, response.statusMessage));
        }
        return status;
    }

    private async getJobEvent(jobId: string): Promise<string[]> {
        var stdoutArray: string[] = [];
        var jobEventUrl = this.getJobEventApi(jobId);
        var request = new WebRequest();
        request.method = 'GET';
        request.body = this.getRequestData();

        while (jobEventUrl) {
            request.uri = jobEventUrl;
            var response = await this.beginRequest(request);
            if (response.statusCode === 200) {
                var totalEvents = response.body['count'];
                var results: any[] = response.body['results'];
                var nextPageUrl = response.body['next'];
                results.forEach((event) => {
                    stdoutArray[parseInt(event['counter'])] = event['stdout'];
                });
                jobEventUrl = (nextPageUrl != null) ? (this._hostname + nextPageUrl) : null;
            } else {
                throw (tl.loc('FailedToGetJobDetails', response.statusCode, response.statusMessage));
            }
        }

        return stdoutArray;
    }


    private isJobInTerminalState(status: string): boolean {
        return status === 'successful' || status === 'failed';
    }

    private async updateRunningStatusAndLogs(jobId: string): Promise<string> {
        var waitTimeInSeconds = 10;
        var timeElapsed = 0;
        var longRunningJobThreshold = 300;
        var lastDisplayedEvent = 0;
        var status: string = "";
        while (true) {
            status = await this.getJobStatus(jobId);
            if (status !== 'pending') {
                var events = await this.getJobEvent(jobId);
                for (var counter = lastDisplayedEvent; counter <= events.length; ++counter) {
                    if (events[counter]) {
                        this._writeLine(events[counter] + "\n");
                    }

                }
                lastDisplayedEvent = counter;
            }
            if (this.isJobInTerminalState(status)) {
                break;
            }

            await this.sleepFor(waitTimeInSeconds);

            timeElapsed += waitTimeInSeconds;
            if (timeElapsed >= longRunningJobThreshold) {
                waitTimeInSeconds = 120;
            }
        }

        return status;
    }

    private async launchJob(): Promise<string> {
        var jobId: string = null;
        var request = new WebRequest();
        request.method = 'POST';
        request.uri = this.getJobLaunchApi();
        request.body = this.getRequestData();

        var response = await this.beginRequest(request);

        if (response.statusCode === 201) {
            jobId = response.body['id'];
        } else {
            throw (tl.loc('CouldnotLaunchJob', response.statusCode, response.statusMessage));
        }
        return jobId;
    }

    private async beginRequest(request: WebRequest): Promise<WebResponse> {
        request.headers = request.headers || {};
        request.headers["Authorization"] = "Basic " + new Buffer(this._username + ":" + this._password).toString('base64');

        var httpResponse = await this.beginRequestInternal(request);
        return httpResponse;
    }

    private beginRequestInternal(request: WebRequest): Promise<WebResponse> {

        tl.debug(util.format("[%s]%s", request.method, request.uri));

        return new Promise<WebResponse>((resolve, reject) => {
            httpObj.send(request.method, request.uri, request.body, request.headers, (error, response, body) => {
                if (error) {
                    reject(error);
                }
                else {
                    var httpResponse = this.toWebResponse(response, body);
                    resolve(httpResponse);
                }
            });
        });
    }

    private sleepFor(sleepDurationInSeconds): Promise<any> {
        return new Promise((resolve, reeject) => {
            setTimeout(resolve, sleepDurationInSeconds * 1000);
        });
    }

    private toWebResponse(response, body): WebResponse {
        var res = new WebResponse();

        if (response) {
            res.statusCode = response.statusCode;
            res.headers = response.headers;
            res.statusMessage = response.statusMessage;
            if (body) {
                try {
                    res.body = JSON.parse(body);
                }
                catch (error) {
                    res.body = body;
                }
            }
        }
        return res;
    }

    private  _jobLaunchUrlFormat: string = "%s/api/v1/job_templates/%s/launch/";
    private  _jobUrlFormat: string = "%s/api/v1/jobs/%s/";
    private  _jobEventUrlFormat: string = "%s/api/v1/jobs/%s/job_events/";
    private  _jobTemplateIdUrlFormat: string = "%s/api/v1/job_templates/?name__exact=%s";

    private _connectedService: string;
    private _jobTemplateName: string;
    private _jobTemplateId: string;
    private _username: string;
    private _password: string;
    private _hostname: string;
    private _lastPolledEvent: number;
}
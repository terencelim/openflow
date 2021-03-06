import * as OAuthServer from "oauth2-server";
import * as winston from "winston";
import * as express from "express";
import { TokenUser, Base } from "openflow-api";
import { Config } from "./Config";
import { Crypt } from "./Crypt";
const Request = OAuthServer.Request;
const Response = OAuthServer.Response;
export class OAuthProvider {
    private _logger: winston.Logger;
    private app: express.Express;
    public static instance: OAuthProvider = null;
    // private clients = [{
    //     id: 'application',	// TODO: Needed by refresh_token grant, because there is a bug at line 103 in https://github.com/oauthjs/node-oauth2-server/blob/v3.0.1/lib/grant-types/refresh-token-grant-type.js (used client.id instead of client.clientId)
    //     clientId: 'application',
    //     clientSecret: 'secret',
    //     grants: [
    //         'password',
    //         'refresh_token',
    //         'authorization_code'
    //     ],
    //     redirectUris: []
    // }];
    private clients = [];
    private tokens = [];
    private codes = {};
    public oauthServer: any = null;
    private authorizationCodeStore: any = {};

    static configure(logger: winston.Logger, app: express.Express): OAuthProvider {
        const instance = new OAuthProvider();
        try {
            OAuthProvider.instance = instance;
            instance._logger = logger;
            instance.app = app;
            instance.oauthServer = new OAuthServer({
                model: instance,
                grants: ['authorization_code', 'refresh_token'],
                accessTokenLifetime: 60 * 60 * 24, // 24 hours, or 1 day
                allowEmptyState: true,
                allowExtendedTokenAttributes: true
            });
            (app as any).oauth = instance.oauthServer;
            app.all('/oauth/token', instance.obtainToken.bind(instance));
            app.get('/oauth/login', async (req, res) => {
                instance.clients = await Config.db.query<Base>({ _type: "oauthclient" }, null, 10, 0, null, "config", Crypt.rootToken());
                if (instance.clients == null || instance.clients.length == 0) return res.status(500).json({ message: 'OAuth not configured' });
                let state = req.params.state;
                if (state == null) state = encodeURIComponent(req.query.state as any);
                const access_type = req.query.access_type;
                const client_id = req.query.client_id;
                const redirect_uri = req.query.redirect_uri;
                const response_type = req.query.response_type;
                const scope = req.query.scope;
                let client = instance.getClientById(client_id);
                if (req.user) {
                    if (client.redirectUris.length > 0) {
                        if (client.redirectUris.indexOf(redirect_uri) == -1) {
                            return res.status(500).json({ message: 'illegal redirect_uri ' + redirect_uri });
                            // client.redirectUris.push(redirect_uri);
                        }
                    }
                    const code = Math.random().toString(36).substr(2, 9);

                    instance._logger.info("[OAuth][" + (req.user as any).username + "] /oauth/login " + state);
                    instance.codes[code] = req.user;
                    instance.codes[code].redirect_uri = redirect_uri;
                    instance.codes[code].client_id = client_id;
                    res.redirect(`${redirect_uri}?state=${state}&code=${code}`);
                } else {
                    instance._logger.info("[OAuth][anon] /oauth/login " + state);
                    res.cookie("originalUrl", req.originalUrl, { maxAge: 900000, httpOnly: true });
                    res.redirect("/login");
                }
            });
            // app.get('/oauth/authorize', instance.authorize.bind(instance));
            app.all('/oauth/authorize', (req, res) => {
                const request = new Request(req);
                const response = new Response(res);
                return instance.oauthServer.authenticate(request, response)
                    .then((token) => {
                        res.json(token.user);
                    }).catch((err) => {
                        console.error(err);
                        res.status(err.code || 500).json(err);
                    });
            });
            // app.all('/oauth/authorize', instance.oauthServer.authenticate.bind(instance));
            // app.all('/oauth/authorize/emails', instance.oauthServer.authenticate.bind(instance));
        } catch (error) {
            console.error(error);
            const json = JSON.stringify(error, null, 3);
            console.error(json);
            throw error;
        }
        return instance;
    }
    authorize(req, res) {
        this._logger.info("[OAuth] authorize");
        const request = new Request(req);
        const response = new Response(res);
        console.log(request.headers);
        return this.oauthServer.authorize(request, response)
            .then((token) => {
                res.json(token);
            }).catch((err) => {
                console.error(err);
                res.status(err.code || 500).json(err);
            });

    }
    authenticateHandler() {
        return {
            handle: (request, response) => {
                //in this example, we store the logged-in user as the 'loginUser' attribute in session
                if (request.session.loginUser) {
                    return { username: request.session.loginUser.username };
                }

                return null;
            }
        };
    }
    obtainToken(req, res) {
        this._logger.info("[OAuth] obtainToken");
        const request = new Request(req);
        const response = new Response(res);
        return this.oauthServer.token(request, response)
            .then((token) => {
                this._logger.info("[OAuth] obtainToken::success: token:");
                res.json(token);
            }).catch((err) => {
                this._logger.info("[OAuth] obtainToken::failed: token:");
                console.error(err);
                res.status(err.code || 500).json(err);
            });
    }
    public async getAccessToken(bearerToken) {
        this._logger.info("[OAuth] getAccessToken " + bearerToken);
        const tokens = await Config.db.query<Base>({ _type: "token", "accessToken": bearerToken }, null, 10, 0, null, "oauthtokens", Crypt.rootToken());
        return tokens.length ? tokens[0] : false;
    }
    public async getRefreshToken(bearerToken) {
        this._logger.info("[OAuth] getRefreshToken " + bearerToken);
        const tokens = await Config.db.query<Base>({ _type: "token", "refreshToken": bearerToken }, null, 10, 0, null, "oauthtokens", Crypt.rootToken());
        return tokens.length ? tokens[0] : false;
    }
    public getClient(clientId, clientSecret) {
        this._logger.info("[OAuth] getClient " + clientId);
        const clients = this.clients.filter((client) => {
            return client.clientId === clientId && client.clientSecret === clientSecret;
        });
        return clients.length ? clients[0] : false;
    }
    public getClientById(clientId) {
        this._logger.info("[OAuth] getClientById " + clientId);
        const clients = this.clients.filter((client) => {
            return client.clientId === clientId;
        });
        return clients.length ? clients[0] : false;
    }

    public async saveToken(token, client, user) {
        this._logger.info("[OAuth] saveToken " + token);
        const result: any = {
            accessToken: token.accessToken,
            access_token: token.accessToken,
            accessTokenExpiresAt: token.accessTokenExpiresAt,
            clientId: client.clientId,
            refreshToken: token.refreshToken,
            refresh_token: token.refreshToken,
            refreshTokenExpiresAt: token.refreshTokenExpiresAt,
            userId: user.id,
            user: user,
            client: client,
            _type: "token"
        };
        this.tokens.push(result);
        await Config.db.InsertOne(result, "oauthtokens", 0, false, Crypt.rootToken());
        return result;
    }
    saveAuthorizationCode(code, client, user) {
        this._logger.info("[OAuth] saveAuthorizationCode " + code);
        // // const codeToSave: any = this.codes[code];
        // const codeToSave: any = {
        //     'authorizationCode': code.authorizationCode,
        //     'expiresAt': code.expiresAt,
        //     'redirectUri': code.redirectUri,
        //     'scope': code.scope,
        //     'client': client.id,
        //     'user': user.username
        // };
        // this.codes[code] = codeToSave;
        // this.revokeAuthorizationCode(code);
        // code = Object.assign({}, code, {
        //     'client': client.id,
        //     'user': user.username
        // });
        return code;
    }
    getAuthorizationCode(code) {
        this._logger.info("[OAuth] getAuthorizationCode " + code);
        let user: TokenUser = this.codes[code];
        const client_id: string = this.codes[code].client_id;
        if (user == null) return null;
        this.revokeAuthorizationCode(code);
        const redirect_uri = (user as any).redirect_uri;
        const expiresAt = new Date();
        expiresAt.setMonth(expiresAt.getMonth() + 1);
        user = TokenUser.From(user);
        let client = this.getClientById(client_id);

        let role = client.defaultrole;
        const keys: string[] = Object.keys(client.rolemappings);
        for (let i = 0; i < keys.length; i++) {
            if (user.HasRoleName(keys[i])) role = client.rolemappings[keys[i]];
        }
        const result = {
            code: code,
            client: this.clients[0],
            user: {
                id: user._id,
                _id: user._id,
                name: user.name,
                username: user.username,
                email: user.username,
                role: role
            },
            expiresAt: expiresAt,
            redirectUri: redirect_uri
        }
        return result;
    }
    revokeAuthorizationCode(code) {
        this._logger.info("[OAuth] revokeAuthorizationCode " + code);
        delete this.codes[code];
        return true;
        // const user: TokenUser = this.codes[code];
        // if (user != null) delete this.codes[code];
        // return code;
    }
}

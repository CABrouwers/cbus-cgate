
var opm = require("openpromise")
var te = require("telnet-engine")
//hello

function findMatch(r) {
    return (s) => {
        let ret = r.exec(s)
        return ret ? ret[1] : undefined
    }
}

7

function findApp(s) {
    const ff = findMatch(/\/\/.+?\/.+?\/(\d+)\//)
    return Number(ff(s))

}




function byteOrNothing(val) {
    let ret = Number(val)
    if (ret >= 0 && ret <= 255) { return ret }
    return undefined
}



function getRampTime(msg) {
    let payload, ramp, unit
    let multi = 1
    if (msg) {
        if (payload = msg.payload) {
            if (ramp = payload.ramptime) {
                if (unit = ramp.unit) {
                    if ((/^s($|ec($|ond($|s$)))/i).exec(unit)) { multi = 1 }
                    if ((/^m($|in($|unte($|s$)))/i).exec(unit)) { multi = 60 }
                    if ((/^h(|r|our)($|s$)/i).exec(unit)) { multi = 3600 }
                    if ((/^ms$|^milli($|s$)/i).exec(unit)) { multi = 0.001 }
                }
                let val = ramp.value ? ramp.value : ramp
                if ((/s($|ec($|ond($|s$)))/i).exec(val)) { multi = 1 }
                if ((/m($|in($|unte($|s$)))/i).exec(val)) { multi = 60 }
                if ((/h(|r|our)($|s$)/i).exec(val)) { multi = 3600 }
                if ((/ms$|^milli($|s$)/i).exec(val)) { multi = 0.001 }
                val = Number((/^(\d*(\.\d*|))/).exec(val)[0]) * multi
                return Math.round(val)
            }
        }
    }


    return 0
}



const findLevel = findMatch(/LEVEL=(.*)$/)


const findPercentage = findMatch(/(\d*)%/)

const findNumber = findMatch(/(\d*)/)





const findSeconds = findMatch(/(\d*)s/)

const findMinutes = findMatch(/(\d*)m/)

const findNetworkReg = findMatch(/^\/\/.+?\/(\d+)\//)


function findNetwork(s) {
    return (Number(findNetworkReg(s)))
}

function text2time(s) {
    let sc = findSeconds(s)
    if (sc) { return sc }
    let mn = findMinutes(s)
    if (mn) { return mn * 60 }
    let nb = findNumber(s)
    if (nb) { return nb }
}

const units = ["°C", "A", "°", "C", "Boolean", "F", "H", "Hz", "J", "kat", "kg/m3", "kg", "l", "l/h", "l/min", "l/s", "ls", "m", "m/min", "m/s", "m/s2", "mol", "N.M", "M", "Ohms", "P", "%", "m/s", "ppm", "rpm", "s", "min", "h", "Sv", "sr", "T", "V", "W/h", "W", "Wb"]


function commandEngineFactory(host, port) {
    engine = new te.Engine(host, port)
    engine.ready = new opm.Defer()
    engine.openTimeout = 5000
    engine.clearOut = 100
    engine.openTries = 3
    engine.autoFlush = 100
    engine.autoOpen = true
    engine.requestString("noop", te.untilRegExp(/^200/)).catch((a) => { engine.ready.fail("no response" + "\n" + a) })
    engine.requestString("PROJECT DIR", te.untilMilli(100))
        .then((arr) => { engine.projects = arr.map(findMatch(/=(.*)$/)); engine.ready.resolve(engine) })
        .catch((a) => { engine.destroy; engine.ready.fail("no response" + "\n" + a) })
    return engine.ready
}


class _Gateway {
    constructor(param) {
        this.ready = new opm.Defer()
        this.host = param.host ? param.host : "127.0.0.1"
        this.commandPort = param.commandPort ? param.commandPort : 20023
        this.eventPort = param.eventPort ? param.eventPort : 20025

        let switch1 = new opm.Defer()
        let switch2 = new opm.Defer()
        this.opened = switch1.then(() => { return switch2 })

        let tries = param.tries ? param.tries : 3
        let wait = param.wait ? param.wait : 10


        opm.untilResolved(() => { return commandEngineFactory(this.host, this.commandPort) }, tries, wait)
            .then((engine) => {
                this.commandEngine = engine
                this.projects = this.commandEngine.projects
                this.opened.resolve()
            })
            .catch((s) => { this.opened.fail(s) })

        this.broadcaster = new opm.Cycle()
        this.eventdEngine = new te.Engine(this.host, this.eventPort)
        this.eventdEngine.open()
        this.eventdEngine.autoOpen = true
        this.eventdEngine.modeStrict = false
        this.eventdEngine.open()
        switch2.resolve()
    }

    openProject(name, networks) {
        let proxy = this.commandEngine.proxy()
        this.opened
            .then(() => {

                name = name ? name : this.projects[0]
                this._ProjectName = name
                if (!this.projects.includes(name)) { throw ("Unknow project: " + name) }
                proxy.requestString("PROJECT LOAD " + name, te.untilRegExp(/^200/)).catch((s) => { this.ready.fail("Cannot use project: " + name + "\n" + s) })
                proxy.requestString("PROJECT USE " + name, te.untilRegExp(/^200/)).catch((s) => { this.ready.fail("Cannot use project: " + name + "\n" + s) })
                proxy.requestString("PROJECT START " + name, te.untilRegExp(/^200/)).catch((a) => { this.ready.fail("Cannot start project: " + name + "\n" + a) })
                if (networks) { this.networks = networks }
                else {
                    proxy.requestString("SHOW " + name + " NETWORKS", te.untilRegExp(/^300/), (s) => { return findMatch(/=(.*)$/)(s).split(",") })
                        .then((arr) => { this.networks = arr[0] })
                        .catch((a) => { this.ready.fail("Cannot find networks: " + name + "\n" + a) })
                }
                return proxy.do(() => { })
            })
            .catch((a) => { this.ready.fail("Unexpected error opening networks 1: " + name + "\n" + a) })
            .finally(() => { proxy.release() })
            .then(() => { return this.setTags() })
            .then(this.ready.resolve)
            .catch((a) => { this.ready.fail("Unexpected error opening networks 2: " + name + "\n" + a) })

        this.ready.then(() => {
            this._receiver = this.eventdEngine.listenString((s) => {
                treatIncoming(this, s)
            })
        })

        return this.ready
    }

    subscribe(f) {
        return this.broadcaster.thenAgain(f)
    }

    autoUpdateStatus(time) {
        clearInterval(this._autoUpdater)
        let gtw = this
        if (time) { this._autoUpdater = setInterval(() => { gtw.updateStatus() }, time * 60 * 1000); gtw.updateStatus() }
    }




    processCommand(msg) {
        this.ready
            .then(() => {
                let line = "-"

                if (!msg.payload || (msg.payload.command != "set" && msg.payload.command != "ramp")) { return }

                let tGrp = this.ID2group[msg.topic]

                let target = tGrp ? tGrp : msg.topic
                let app = findApp(target)
                if (app >= 48 && app <= 95) {
                    let val = this.getPayloadValue(msg, target)
                    let ramptime = getRampTime(msg)
                    line = "RAMP " + target + " " + val + " " + ramptime + "s"
                }
                else if (app == 202) {
                    line = "TRIGGER EVENT " + target + " " + this.getPayloadValue(msg, target)
                }
                else if (app == 203) {
                    line = "ENABLE SET " + target + " " + this.getPayloadValue(msg, target)
                }
                else {
                    line = undefined
                }

                if (line) { this.commandEngine.requestString(line, te.noResponse()) }
            })
    }

    terminate() {
        this.broadcaster.terminate()
        this.commandEngine.destroy()
        this.eventdEngine.destroy()
    }


    seekLevel(grp, level) {
        let levels = this.group2levels[grp]
        if (levels) {
            let levelElem = levels.find(element => element.name = level)
            return levelElem ? levelElem.address : level
        }
        else { return undefined }
    }

    getPayloadValue(msg, grp) {
        let payload, value, lvl
        if (msg) {
            payload = msg.payload
            if (payload) {
                lvl = payload.level
                if (lvl) {
                    value = lvl.value ? lvl.value : lvl
                    let level = this.seekLevel(grp, value)
                    if (level) { return level }
                    if (value === false || (/^(off|false)$/i).exec(value)) { return 0 }
                    if (value === true || (/^(on|true)$/i).exec(value)) { return 255 }
                    let p
                    if (p = /^([\d.,]+)%$/.exec(value)) { return byteOrNothing(Math.round(255 * p[1] / 100)) }
                    if (lvl.scale) { return byteOrNothing(Math.round(255 * value / lvl.scale)) }
                    return byteOrNothing(value)
                }
            }
        }
        return undefined
    }


    setTags() {

        let ID2group = {}
        let group2ID = {}
        let group2levels = {}
        let proxy = this.commandEngine.proxy()
        let ret = []
        let sema1 = new opm.Defer()
        let tagSet = new opm.Defer()

        this.opened
            .then(() => {
                let nums = []
                this.networks.map((s) => {
                    proxy.requestString("CGL EXPORT " + this._ProjectName + " " + s, te.untilRegExp(/^344/))
                        .then((r) => {
                            let tmp = JSON.parse(findMatch(/^.*?({.*}).*?$/)(r[1])).networks
                            tmp.map((a) => {
                                if (!nums.includes(a.address)) { ret.push(a); nums.push(a.address) }
                            })
                        })
                        .then(() => { return proxy.do(() => { }) })
                        .then(() => { sema1.resolve() })
                })
            })
            .catch((a) => { sema1.fail("Failed to export CGL " + this._ProjectName + "\n" + a) })
        sema1.
            then(() => {
                this.cgl = ret

                ret.map((netobj) => {
                    let netstring = "//" + this._ProjectName + "/" + netobj.address.toString()
                    netobj.applications.map((appobj) => {
                        let appnum = appobj.address
                        let appstring = netstring + "/" + appnum.toString()
                        if (appobj.groups) {
                            appobj.groups.map((groupobj) => {
                                let grname = appstring + "/" + groupobj.address.toString()
                                ID2group[groupobj.name] = grname
                                group2ID[grname] = groupobj.name
                                if (groupobj.levels) {
                                    group2levels[grname] = groupobj.levels
                                }

                            })
                        }
                    })
                })
                this.ID2group = ID2group
                this.group2ID = group2ID
                this.group2levels = group2levels
                this.ready.resolve()
            })
            .then(() => { tagSet.resolve() })
            .catch((a) => { tagSet.fail("Unexpected error opening network: " + this._ProjectName + "\n" + a) })
            .finally(proxy.release)
        return tagSet
    }

    text2lLevel(level, grp) {
        let g2l = this.group2levels
        let levels = g2l[grp]
        if (levels) {
            let levelElem = levels.find(element => element.address = level)
            return levelElem ? levelElem.name : level
        }
        else {
            let pc = findPercentage(level)
            if (pc) { return { value: Number(pc), scale: 100 } }
            let nb = findNumber(level)
            if (nb) { return { value: Number(nb), scale: 255 } }
            return { value: level }
        }
    }


    updateStatus() {
        this.ready
            .then(() => {
                let bcast = this.broadcaster
                let g2ID = this.group2ID
                let qe = new opm.Queue()
                Object.keys(this.group2ID).forEach((s) => {
                    qe.enQueue(() => {
                        return this.commandEngine.requestString("GET " + s + " LEVEL", te.oneLine(), (l) => {
                            if (/^300/.exec(l)) {
                                let level = findLevel(l)
                                let ID = g2ID[s]
                                bcast.repeat({ topic: ID, payload: { command: "status", level: this.text2lLevel(level, s) } })
                            }
                        })
                    })
                })

            }
            )
    }

    group2IDFunction(s) {
        let ret = this.group2ID[s]
        if (ret) { return ret }
        else { return s }
    }

    treatIncoming(s) {
        let bcast = this.broadcaster
        let network = -1
        words = s.split(" ")

        let msg = undefined
        if (words[0] == "lighting") {
            let target = this.group2IDFunction(words[2])
            network = findNetwork(words[2])
            switch (words[1]) {
                case "on":
                    msg = { topic: target, payload: { command: "set", level: "on" } }
                    break
                case "off":
                    msg = { topic: target, payload: { command: "set", level: "off" } }
                    break
                case "ramp":
                    msg = { topic: target, payload: { command: "set", level: this.text2lLevel(words[3], words[2]), ramptime: text2time(words[4]) } }
                    break
                default:
            }
        } else if (words[0] == "trigger" && words[1] == "event") {
            let target = this.group2IDFunction(words[2])
            network = findNetwork(words[2])
            msg = {
                flag: true,
                topic: target, payload: { command: "set", level: this.text2lLevel(words[3], words[2]) }
            }
        } else if (words[0].slice(0, 4) == "hvac") {
            let target = this.group2IDFunction(words[2])
            network = findNetwork(words[2])
            msg = {
                topic: target, payload: { command: "set", level: this.text2lLevel(words[1], words[2]) }
            }
        } else if (words[0] == "enable" && words[1] == "set") {
            let target = this.group2IDFunction(words[2])
            network = findNetwork(words[2])
            msg = {
                topic: target, payload: { command: "set", level: this.text2lLevel(gwords[3], words[2]) }
            }

        } else if (words[0] == "measurement" && words[1] == "data") {
            let target = this.group2IDFunction(words[2])
            network = findNetwork(words[2])
            msg = {
                topic: target, payload: { command: "status", level: { value: Number(words[3]) * Math.pow(10, Number(words[4])), unit: units[Number(words[5])] } }
            }
        }

        if (msg && this.networks.includes(network)) { bcast.repeat(msg) }
    }


}

class Gateway {

    constructor(param) {
        var gtw = new _Gateway(param)
        this.updateStatus = () => { gtw.updateStatus() }
        this.processCommand = (msg) => { gtw.processCommand(msg) }
        this.openProject = (name, networks) => { gtw.openProject(name, networks) }
        this.subscribe = (f) => { gtw.subscribe(f) }
        this.autoUpdateStatus = (t) => { gtw.autoUpdateStatus(t) }
        this.terminate = () => { gtw.terminate() }

        Object.defineProperty(this, 'ready', {
            get() {
                return gtw.ready
            }
        })

        Object.defineProperty(this, 'opened', {
            get() {
                return gtw.opened
            }
        })

    }

}




module.exports = {
    Gateway
}
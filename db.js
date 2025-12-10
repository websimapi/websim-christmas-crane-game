// Singleton management for user data
export class DataManager {
    constructor() {
        this.room = new WebsimSocket();
        this.collectionName = 'christmas_crane_users_v1';
        this.userRecord = null;
        this.currentUser = null;
    }

    async init() {
        this.currentUser = await window.websim.getCurrentUser();
        
        return new Promise((resolve) => {
            let resolved = false;
            const collection = this.room.collection(this.collectionName).filter({ username: this.currentUser.username });

            // Robust check: Subscribe to updates to catch initial data load
            const unsubscribe = collection.subscribe((records) => {
                if (resolved) return;
                
                // If we receive records, the user exists
                if (records && records.length > 0) {
                    this.userRecord = records[0];
                    resolved = true;
                    unsubscribe();
                    resolve(this.userRecord);
                }
            });

            // Fallback: If no records found after 1 second, assume new user
            setTimeout(async () => {
                if (resolved) return;
                unsubscribe();
                
                // Double check before creating
                const records = collection.getList();
                if (records && records.length > 0) {
                    this.userRecord = records[0];
                } else {
                    try {
                        // Create the single row for this user
                        this.userRecord = await this.room.collection(this.collectionName).create({
                            play_data: JSON.stringify({ last_played: 0 }),
                            inventory: JSON.stringify([])
                        });
                    } catch (e) {
                        console.error("Error creating user record:", e);
                    }
                }
                resolved = true;
                resolve(this.userRecord);
            }, 1000);
        });
    }

    canPlay() {
        if (!this.userRecord) return false;
        const playData = JSON.parse(this.userRecord.play_data);
        const lastPlayed = playData.last_played || 0;
        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000;
        return (now - lastPlayed) > oneDay;
    }

    getTimeUntilNextPlay() {
        if (!this.userRecord) return 0;
        const playData = JSON.parse(this.userRecord.play_data);
        const lastPlayed = playData.last_played || 0;
        const oneDay = 24 * 60 * 60 * 1000;
        const nextPlay = lastPlayed + oneDay;
        return Math.max(0, nextPlay - Date.now());
    }

    async useFreePlay() {
        if (!this.userRecord) await this.init();
        
        const playData = {
            last_played: Date.now()
        };

        // Update the first column (play_data)
        await this.room.collection(this.collectionName).update(this.userRecord.id, {
            play_data: JSON.stringify(playData)
        });
        
        // Update local cache
        this.userRecord.play_data = JSON.stringify(playData);
    }

    async addPrize(prizeName) {
        if (!this.userRecord) await this.init();

        const currentInv = JSON.parse(this.userRecord.inventory || "[]");
        currentInv.push({
            name: prizeName,
            won_at: Date.now()
        });

        // Update the second column (inventory)
        await this.room.collection(this.collectionName).update(this.userRecord.id, {
            inventory: JSON.stringify(currentInv)
        });

        this.userRecord.inventory = JSON.stringify(currentInv);
    }

    getInventory() {
        if (!this.userRecord) return [];
        return JSON.parse(this.userRecord.inventory || "[]");
    }
}
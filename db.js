// Singleton management for user data
export class DataManager {
    constructor() {
        this.room = null; // Lazy init
        this.collectionName = 'christmas_crane_users_v1';
        this.userRecord = null;
        this.currentUser = null;
    }

    async init() {
        if (this.initPromise) return this.initPromise;

        this.initPromise = new Promise(async (resolve, reject) => {
            try {
                if (!window.WebsimSocket) {
                    throw new Error("WebsimSocket SDK not loaded");
                }
                this.room = new WebsimSocket();
                this.currentUser = await window.websim.getCurrentUser();
                
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
                    
                    try {
                        // Double check before creating
                        const records = collection.getList();
                        if (records && records.length > 0) {
                            this.userRecord = records[0];
                        } else {
                            // Create the single row for this user
                            this.userRecord = await this.room.collection(this.collectionName).create({
                                play_data: JSON.stringify({ last_played: 0 }),
                                inventory: JSON.stringify([])
                            });
                        }
                        resolved = true;
                        resolve(this.userRecord);
                    } catch (e) {
                        console.error("Error creating user record:", e);
                        // If creation fails, we can't play, but we shouldn't crash completely.
                        // Resolve with null so UI can show error or retry.
                        resolved = true;
                        resolve(null);
                    }
                }, 1000);
            } catch (err) {
                console.error("DB Init Fatal Error:", err);
                reject(err);
            }
        });
        
        return this.initPromise;
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
        // Add a timeout race to prevent infinite hanging
        const updatePromise = this.room.collection(this.collectionName).update(this.userRecord.id, {
            play_data: JSON.stringify(playData)
        });

        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error("Update timed out")), 5000)
        );

        await Promise.race([updatePromise, timeoutPromise]);
        
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
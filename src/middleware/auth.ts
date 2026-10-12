import { Request, Response, NextFunction } from "express";
import {getAuth} from "firebase-admin/auth";
import {pool}  from "../db";

declare global {
    namespace Express {
        interface Request {
            authUser?: {
                id : string;
                firebaseUid: string
            };
        }
    }
}

export async function authenticate(
    req:Request,
    res:Response, 
    next:NextFunction): Promise<void> {
     try{
        const header = req.header.authorization;
        if(!header?.startswith("Bearer ")) {
            res.status(401).json({message: "Authentication required."});
        }
        const token = header.slice(7);
        const decoded = await getAuth().verifyIdToken(token);
        const result = await pool.query<{id: string; firebase_uid: string}>
        (`SELECT id, firebase_uid FROM users WHERE firebase_uid = $1`, [decoded.uid]);
     
       if(result.rowCount !== 1){
         res.status(401).json({ message: "User not registered"});
         return;
       }
       req.authUser = {
        id: result.row[0].id,
        firebaseUid:result.rows[0].firebase_uid,
       };
       next();
    } catch{
        res.status(401).json({ message: "Invalid authebtication token"});
    }
}